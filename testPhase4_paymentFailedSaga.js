import jwt from 'jsonwebtoken';
import { fork } from 'child_process';
import { pool, getEventStream } from './src/eventStore.js';
import { app } from './src/server.js';
import { redis as publisherRedis } from './src/eventPublisher.js';
import { seed } from './seedReferenceData.js';
import { processSagaEvent } from './src/saga/bookingSaga.js';
import { rebuildState } from './src/bookingAggregate.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runSagaTest() {
  console.log('--- TapToTurf Phase 4: Payment Failed Saga Verification ---');

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

  // Spawn availability projection consumer and booking saga processes
  console.log('Spawning background consumer processes...');
  const availProjPath = path.join(__dirname, 'src', 'projections', 'availabilityProjection.js');
  const sagaPath = path.join(__dirname, 'src', 'saga', 'bookingSaga.js');

  const availProc = fork(availProjPath);
  const sagaProc = fork(sagaPath);

  await new Promise(resolve => setTimeout(resolve, 1500));

  try {
    // Truncate tables for a clean test run
    await pool.query('TRUNCATE TABLE event_log CASCADE;');
    await pool.query('TRUNCATE TABLE availability_view, booking_history_view CASCADE;');

    const bookingDate = '2026-11-20';

    // 1. Reserve a slot
    console.log('Reserving court slot (18:00 - 20:00)...');
    const reserveRes = await fetch(`http://localhost:${port}/api/bookings/reserve`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ courtId, userId, bookingDate, startHour: 18, durationHours: 2 })
    });
    const { streamId } = await reserveRes.json();
    console.log(`Reserved stream ID: ${streamId}`);

    // 2. Initiate payment
    console.log('Initiating payment...');
    await fetch(`http://localhost:${port}/api/bookings/${streamId}/initiate-payment`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });

    // 3. Trigger payment failure
    console.log('Triggering payment failure (gateways callback)...');
    const failRes = await fetch(`http://localhost:${port}/api/bookings/${streamId}/fail-payment`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const failData = await failRes.json();
    console.log(`Returned status: ${failData.status}`);

    // 4. Wait/Poll for the Saga's compensation to trigger and complete
    console.log('Polling for saga compensating release to become visible...');
    let isReleased = false;
    let pollCount = 0;
    while (!isReleased && pollCount < 100) {
      pollCount++;
      const state = await rebuildState(streamId);
      if (state.status === 'released') {
        isReleased = true;
        console.log(`Success: Saga executed compensating action. Status is 'released'.`);
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    if (!isReleased) {
      throw new Error('TIMEOUT: booking did not transition to released status via saga.');
    }

    // 5. Verify availability_view projection is updated to 'released'
    console.log('Verifying availability_view projection shows status "released"...');
    let projectionSynced = false;
    let availRes;
    for (let i = 0; i < 100; i++) {
      availRes = await pool.query('SELECT status FROM availability_view WHERE stream_id = $1', [streamId]);
      if (availRes.rows.length > 0 && availRes.rows[0].status === 'released') {
        projectionSynced = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!projectionSynced) {
      throw new Error(`Expected availability_view status "released", but got "${availRes.rows[0]?.status}"`);
    }
    console.log('Projection view matches successfully!');

    // 6. Test duplicate-delivery idempotency
    console.log('Simulating duplicate PAYMENT_FAILED event delivery to saga process...');
    // Retrieve the PAYMENT_FAILED event row from Postgres
    const events = await getEventStream(streamId);
    const paymentFailedEvent = events.find(e => e.event_type === 'PAYMENT_FAILED');

    if (!paymentFailedEvent) {
      throw new Error('PAYMENT_FAILED event was not found in stream.');
    }

    // Call processSagaEvent manually twice
    console.log('Calling processSagaEvent manually: First retry...');
    await processSagaEvent(paymentFailedEvent);

    console.log('Calling processSagaEvent manually: Second retry...');
    await processSagaEvent(paymentFailedEvent);

    // Rebuild final state to ensure version remains unchanged
    const finalState = await rebuildState(streamId);
    console.log(`Final state version: ${finalState.version}`);

    const finalEvents = await getEventStream(streamId);
    const releaseEvents = finalEvents.filter(e => e.event_type === 'SLOTS_RELEASED');
    if (releaseEvents.length !== 1) {
      throw new Error(`Idempotency check FAILED: expected exactly 1 SLOTS_RELEASED event, found ${releaseEvents.length}`);
    }
    console.log('SUCCESS: Duplicate delivery handled idempotently without duplicate appends!');

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
    await killChild(sagaProc, 'Booking Saga');

    console.log('Stopping HTTP server...');
    await new Promise(resolve => server.close(resolve));

    console.log('Closing database and redis publisher connections...');
    await publisherRedis.quit();
    await pool.end();
  }

  console.log('--- Phase 4 Payment Failed Saga Test Completed Successfully ---');
  
  // Diagnostics
  console.log('Active handles:', process._getActiveHandles().map(h => h.constructor.name));
  console.log('Active requests:', process._getActiveRequests().length);

  process.exit(0);
}

runSagaTest().catch(err => {
  console.error('Payment Failed Saga Test FAILED:', err);
  process.exit(1);
});
