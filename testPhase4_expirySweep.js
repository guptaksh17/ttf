import jwt from 'jsonwebtoken';
import { fork } from 'child_process';
import { pool, appendEvent, getEventStream } from './src/eventStore.js';
import { app } from './src/server.js';
import { redis as publisherRedis, publishEvent } from './src/eventPublisher.js';
import { seed } from './seedReferenceData.js';
import { rebuildState } from './src/bookingAggregate.js';
import { runSweep } from './src/saga/expirySweeper.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runExpiryTest() {
  console.log('--- TapToTurf Phase 4: Hold-Expiry Sweep Verification ---');

  // Pre-flight check
  await publisherRedis.ping();

  console.log('Seeding reference database...');
  await seed(pool);

  const courtRes = await pool.query("SELECT id FROM courts WHERE name = 'Court 1' LIMIT 1;");
  const userRes = await pool.query("SELECT id FROM users WHERE email = 'test-fixture-1@internal.test';");

  const courtId = courtRes.rows[0].id;
  const userId = userRes.rows[0].id;
  const token = jwt.sign({ id: userId, role: 'user' }, process.env.JWT_SECRET || 'taptoturf_secret', { expiresIn: '1d' });

  // Start HTTP Command/Read server
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port;
  console.log(`Command Server running on port ${port}`);

  // Spawn availability projection consumer process
  console.log('Spawning background projection consumer...');
  const availProjPath = path.join(__dirname, 'src', 'projections', 'availabilityProjection.js');
  const availProc = fork(availProjPath);

  await new Promise(resolve => setTimeout(resolve, 1500));

  try {
    // Truncate tables for a clean test run
    await pool.query('TRUNCATE TABLE event_log CASCADE;');
    await pool.query('TRUNCATE TABLE availability_view, booking_history_view CASCADE;');

    const bookingDate = '2026-11-21';

    // ----------------------------------------------------
    // SCENARIO 1: Expired reservation gets released by sweeper
    // ----------------------------------------------------
    console.log('\n--- Scenario 1: Releasing expired hold ---');
    
    // Reserve slot with expired timestamp (10 seconds ago)
    const expiredTimestamp = new Date(Date.now() - 10 * 1000).toISOString();
    console.log(`Reserving slot with expired timestamp: ${expiredTimestamp}`);

    const reserveRes = await fetch(`http://localhost:${port}/api/bookings/reserve`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        courtId,
        userId,
        bookingDate,
        startHour: 10,
        durationHours: 2,
        reservationExpiresAt: expiredTimestamp
      })
    });

    const { streamId: expiredStreamId } = await reserveRes.json();
    console.log(`Reserved stream ID: ${expiredStreamId}`);

    // Wait for availability_view projection to sync status 'reserved'
    let availReady = false;
    let pollCount = 0;
    while (!availReady && pollCount < 100) {
      pollCount++;
      const res = await pool.query('SELECT status, reservation_expires_at FROM availability_view WHERE stream_id = $1', [expiredStreamId]);
      if (res.rows.length > 0 && res.rows[0].status === 'reserved') {
        availReady = true;
        console.log(`Availability view ready. status: ${res.rows[0].status}, expires: ${res.rows[0].reservation_expires_at.toISOString()}`);
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    if (!availReady) {
      throw new Error('TIMEOUT: availability_view did not sync initial reservation hold.');
    }

    // Run the sweeper once
    console.log('Triggering expiry sweeper cycle...');
    await runSweep();

    // Verify stream is now 'released'
    const finalState = await rebuildState(expiredStreamId);
    console.log(`Rebuilt state status after sweep: ${finalState.status}`);
    if (finalState.status !== 'released') {
      throw new Error(`Expected status 'released' for expired hold, but got '${finalState.status}'`);
    }

    // Wait for projection to update to 'released'
    let projReleased = false;
    pollCount = 0;
    while (!projReleased && pollCount < 100) {
      pollCount++;
      const res = await pool.query('SELECT status FROM availability_view WHERE stream_id = $1', [expiredStreamId]);
      if (res.rows[0].status === 'released') {
        projReleased = true;
        console.log('Availability view successfully updated to "released" by sweeper compensating event.');
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    if (!projReleased) {
      throw new Error('TIMEOUT: availability_view status did not sync to released.');
    }

    // ----------------------------------------------------
    // SCENARIO 2: Race condition - confirmed booking at expiry boundary
    // ----------------------------------------------------
    console.log('\n--- Scenario 2: Race safety check ---');
    
    // 1. Reserve slot
    const raceStreamId = crypto.randomUUID();
    const reservationExpiresAt = new Date(Date.now() - 5 * 1000).toISOString(); // Expired 5s ago
    console.log(`Reserving slot ${raceStreamId} with expired timestamp: ${reservationExpiresAt}`);

    const payload = {
      courtId,
      userId,
      bookingDate,
      startHour: 14,
      durationHours: 2,
      totalAmount: 2400,
      reservationExpiresAt
    };

    // Append reservation directly
    const rEvent = await appendEvent(raceStreamId, 0, 'SLOTS_RESERVED', payload);
    // Publish so it is written to availability_view
    await publishEvent(rEvent);

    // Wait for availability_view projection to sync
    let raceAvailReady = false;
    pollCount = 0;
    while (!raceAvailReady && pollCount < 100) {
      pollCount++;
      const res = await pool.query('SELECT status FROM availability_view WHERE stream_id = $1', [raceStreamId]);
      if (res.rows.length > 0 && res.rows[0].status === 'reserved') {
        raceAvailReady = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    // 2. Simulate concurrent payment confirmation BEFORE sweeper runs, but DO NOT sync to availability_view yet
    console.log('Appending payment confirmation events directly to event_log...');
    await appendEvent(raceStreamId, 1, 'PAYMENT_INITIATED', {});
    await appendEvent(raceStreamId, 2, 'PAYMENT_CONFIRMED', {});
    const confirmEvent = await appendEvent(raceStreamId, 3, 'BOOKING_CONFIRMED', {});

    // Note: Do NOT publish these events yet, so availability_view remains status = 'reserved' (simulating lag)
    const checkView = await pool.query('SELECT status FROM availability_view WHERE stream_id = $1', [raceStreamId]);
    console.log(`Database availability_view status is still: '${checkView.rows[0].status}'`);

    // Verify built aggregate status is 'booking_confirmed'
    const raceState = await rebuildState(raceStreamId);
    console.log(`Authoritative rebuilt aggregate state status is: '${raceState.status}'`);
    if (raceState.status !== 'booking_confirmed') {
      throw new Error(`Expected state to be booking_confirmed, got ${raceState.status}`);
    }

    // 3. Trigger expiry sweeper cycle
    console.log('Triggering expiry sweeper cycle (simulating concurrent sweep execution)...');
    await runSweep();

    // 4. Assert that the sweeper did NOT append SLOTS_RELEASED
    const postSweepState = await rebuildState(raceStreamId);
    console.log(`Authoritative aggregate status after sweep: '${postSweepState.status}'`);
    if (postSweepState.status !== 'booking_confirmed') {
      throw new Error(`RACE FAILURE: The sweeper incorrectly released a confirmed booking! Status was changed to '${postSweepState.status}'`);
    }
    console.log('SUCCESS: Sweeper skipped releasing the confirmed booking, preserving race safety!');

    // 5. Sync confirmation events and verify final state
    await publishEvent(confirmEvent);
    console.log('Confirmed booking synced cleanly.');

  } finally {
    console.log('Tearing down background processes and servers...');

    const killChild = async (child, name) => {
      if (!child) return;
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          console.log(`Force killing ${name} (SIGKILL)...`);
          child.kill('SIGKILL');
          resolve();
        }, 3000);

        child.once('exit', (code) => {
          clearTimeout(timer);
          console.log(`${name} exited cleanly with code ${code}.`);
          resolve();
        });

        child.kill('SIGTERM');
      });
    };

    await killChild(availProc, 'Availability Projection');

    console.log('Stopping HTTP server...');
    await new Promise(resolve => server.close(resolve));

    console.log('Closing database and redis publisher connections...');
    await publisherRedis.quit();
    await pool.end();
  }

  console.log('--- Phase 4 Expiry Sweep Test Completed Successfully ---');
  
  // Diagnostics
  console.log('Active handles:', process._getActiveHandles().map(h => h.constructor.name));
  console.log('Active requests:', process._getActiveRequests().length);

  process.exit(0);
}

runExpiryTest().catch(err => {
  console.error('Expiry sweep test FAILED:', err);
  process.exit(1);
});
