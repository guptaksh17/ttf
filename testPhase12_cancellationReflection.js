import jwt from 'jsonwebtoken';
import { fork } from 'child_process';
import { pool } from './src/eventStore.js';
import { app } from './src/server.js';
import { redis as publisherRedis } from './src/eventPublisher.js';
import { seed } from './seedReferenceData.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runTest() {
  console.log('=== TapToTurf Phase 12 Part A: Cancellation Reflection Regression Test ===');

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
  console.log('Spawning background availability projection consumer...');
  const availProjPath = path.join(__dirname, 'src', 'projections', 'availabilityProjection.js');
  
  // Make sure to disable batching or run it cleanly with config
  const env = { ...process.env, PROJECTION_DISABLE_BATCHING: 'true' };
  const availProc = fork(availProjPath, [], { env });

  await new Promise(resolve => setTimeout(resolve, 1500));

  try {
    // Truncate tables for a clean test run
    await pool.query('TRUNCATE TABLE event_log CASCADE;');
    await pool.query('TRUNCATE TABLE availability_view, booking_history_view CASCADE;');

    const bookingDate = '2026-11-20';
    const startHour = 18;

    // 1. Reserve a slot
    console.log('1. Reserving court slot (18:00 - 20:00)...');
    const reserveRes = await fetch(`http://localhost:${port}/api/bookings/reserve`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ courtId, userId, bookingDate, startHour, durationHours: 2 })
    });
    if (!reserveRes.ok) {
      throw new Error(`Failed to reserve slot: ${await reserveRes.text()}`);
    }
    const { streamId } = await reserveRes.json();
    console.log(`- Reserved stream ID: ${streamId}`);

    // 2. Initiate payment
    console.log('2. Initiating payment...');
    const initRes = await fetch(`http://localhost:${port}/api/bookings/${streamId}/initiate-payment`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!initRes.ok) {
      throw new Error(`Failed to initiate payment: ${await initRes.text()}`);
    }

    // 3. Confirm payment & booking
    console.log('3. Confirming payment & booking...');
    const confirmRes = await fetch(`http://localhost:${port}/api/bookings/${streamId}/confirm-payment`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!confirmRes.ok) {
      throw new Error(`Failed to confirm payment: ${await confirmRes.text()}`);
    }

    // Wait a brief moment for the outbox relay to pick up & publish the booking confirmation event,
    // and for the availability projection to update the status in availability_view to 'booking_confirmed'
    console.log('Waiting for projection to process confirmation...');
    await new Promise(resolve => {
      let attempts = 0;
      const interval = setInterval(async () => {
        attempts++;
        const availRes = await pool.query('SELECT status FROM availability_view WHERE stream_id = $1', [streamId]);
        if (availRes.rows.length > 0 && availRes.rows[0].status === 'booking_confirmed') {
          clearInterval(interval);
          console.log(`- Projection updated: status is ${availRes.rows[0].status}`);
          resolve();
        } else if (attempts > 50) {
          clearInterval(interval);
          resolve(); // Let it fail during assertions
        }
      }, 100);
    });

    // Verify projection has 'booking_confirmed'
    const preCancelRes = await pool.query('SELECT status FROM availability_view WHERE stream_id = $1', [streamId]);
    if (preCancelRes.rows[0]?.status !== 'booking_confirmed') {
      throw new Error(`Expected availability status to be 'booking_confirmed', got '${preCancelRes.rows[0]?.status}'`);
    }

    // 4. Cancel the booking
    console.log('4. Cancelling booking via API...');
    const cancelRes = await fetch(`http://localhost:${port}/api/bookings/${streamId}/cancel`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!cancelRes.ok) {
      throw new Error(`Failed to cancel booking: ${await cancelRes.text()}`);
    }
    const cancelData = await cancelRes.json();
    console.log(`- Cancelled status returned from aggregate: ${cancelData.status}`);

    // Wait for projection to reflect the cancellation
    console.log('Waiting for availability projection to reflect cancellation...');
    await new Promise(resolve => {
      let attempts = 0;
      const interval = setInterval(async () => {
        attempts++;
        const availRes = await pool.query('SELECT status FROM availability_view WHERE stream_id = $1', [streamId]);
        if (availRes.rows.length > 0 && availRes.rows[0].status === 'cancelled') {
          clearInterval(interval);
          console.log(`- Projection updated: status is ${availRes.rows[0].status}`);
          resolve();
        } else if (attempts > 50) {
          clearInterval(interval);
          resolve(); // Let it fail during assertions
        }
      }, 100);
    });

    // 5. Query availability view via API
    console.log('5. Querying GET /api/availability for slot...');
    const getAvailRes = await fetch(`http://localhost:${port}/api/availability?courtId=${courtId}&date=${bookingDate}`);
    if (!getAvailRes.ok) {
      throw new Error(`Failed to fetch availability: ${await getAvailRes.text()}`);
    }
    const availabilityData = await getAvailRes.json();
    console.log('- Availability response from read API:', JSON.stringify(availabilityData));

    const targetSlot = availabilityData.find(item => item.start_hour === startHour);
    if (!targetSlot) {
      throw new Error('Could not find the slot availability record in API output.');
    }
    if (targetSlot.status !== 'cancelled') {
      throw new Error(`Expected slot status to be 'cancelled', got '${targetSlot.status}'`);
    }

    // 6. Test booking the same slot again to confirm it is fully freed and bookable
    console.log('6. Re-booking the same slot (18:00 - 20:00) to confirm it is fully freed...');
    const rebookRes = await fetch(`http://localhost:${port}/api/bookings/reserve`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ courtId, userId, bookingDate, startHour, durationHours: 2 })
    });
    if (!rebookRes.ok) {
      throw new Error(`Re-booking failed: ${await rebookRes.text()}`);
    }
    const rebookData = await rebookRes.json();
    console.log(`- Successfully re-booked slot! New stream ID: ${rebookData.streamId}`);

    console.log('\nSUCCESS: Phase 12 Part A Regression test passed cleanly!');
    process.exitCode = 0;
  } catch (error) {
    console.error('\nFAILURE in regression test:', error);
    process.exitCode = 1;
  } finally {
    // Terminate processes and connections
    console.log('Cleaning up test resources...');
    availProc.kill('SIGKILL');
    server.close();
    await publisherRedis.quit();
    await pool.end();
    process.exit();
  }
}

runTest();
