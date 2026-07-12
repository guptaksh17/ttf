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
  console.log('--- TapToTurf Phase 3 Integration & CQRS Verification ---');

  // 0. Pre-flight check for Redis reachability
  console.log('Pre-flight: Checking Redis connectivity...');
  try {
    await Promise.race([
      publisherRedis.ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timeout')), 1500))
    ]);
    console.log('Pre-flight: Redis is reachable.');
  } catch (err) {
    console.error(`\nREDIS CONNECTION FAILED: ${err.message}.`);
    console.error('Please ensure that Redis is installed and running locally on port 6379 before running Phase 3 tests.\n');
    await pool.end();
    await publisherRedis.quit();
    process.exit(1);
  }

  // 1. Seed reference data
  console.log('Seeding reference database...');
  await seed(pool);

  // Retrieve a real court and user
  const courtRes = await pool.query("SELECT id FROM courts WHERE name = 'Court 1' LIMIT 1;");
  const userRes = await pool.query("SELECT id FROM users WHERE email = 'test-fixture-1@internal.test';");

  if (courtRes.rows.length === 0 || userRes.rows.length === 0) {
    throw new Error('Reference data not found. Please run seed script first.');
  }

  const courtId = courtRes.rows[0].id;
  const userId = userRes.rows[0].id;
  const token = jwt.sign({ id: userId, role: 'user' }, process.env.JWT_SECRET || 'taptoturf_secret', { expiresIn: '1d' });

  // 2. Start the Express command/read server on ephemeral port
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port;
  console.log(`Command & Read Server running on port ${port}`);

  // 3. Spawn projection consumer processes
  console.log('Spawning projection consumer processes...');
  const availProjPath = path.join(__dirname, 'src', 'projections', 'availabilityProjection.js');
  const histProjPath = path.join(__dirname, 'src', 'projections', 'bookingHistoryProjection.js');

  const availProc = fork(availProjPath);
  const histProc = fork(histProjPath);

  // Allow processes a brief moment to initialize
  await new Promise(resolve => setTimeout(resolve, 1500));

  try {
    // Truncate event_log and projection views to start from a clean slate
    console.log('Truncating tables for clean state...');
    await pool.query('TRUNCATE TABLE event_log CASCADE;');
    await pool.query('TRUNCATE TABLE availability_view CASCADE;');
    await pool.query('TRUNCATE TABLE booking_history_view CASCADE;');

    const bookingDate = '2026-10-15';
    const startHour = 10;
    const durationHours = 2;

    console.log('\nStep 1: Sending slot reservation command (POST /api/bookings/reserve)...');
    const commandIssuedTime = Date.now();

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
        startHour,
        durationHours
      })
    });

    if (reserveRes.status !== 201) {
      const errText = await reserveRes.text();
      throw new Error(`Reservation failed with status ${reserveRes.status}: ${errText}`);
    }

    const { streamId } = await reserveRes.json();
    console.log(`Reservation created successfully. Stream ID: ${streamId}`);

    // Step 2: Poll Availability View
    console.log('\nStep 2: Polling GET /api/availability for projection update...');
    let availVisible = false;
    let availLag = 0;
    let availPollAttempts = 0;

    while (!availVisible && availPollAttempts < 100) {
      availPollAttempts++;
      const res = await fetch(`http://localhost:${port}/api/availability?courtId=${courtId}&date=${bookingDate}`);
      if (res.status === 200) {
        const rows = await res.json();
        const booking = rows.find(r => r.stream_id === streamId);
        if (booking && booking.status === 'reserved') {
          availVisible = true;
          availLag = Date.now() - commandIssuedTime;
          console.log(`Success: Found in availability view with status "reserved". Rows count: ${rows.length}`);
          break;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    if (!availVisible) {
      throw new Error('TIMEOUT: booking did not appear in availability_view after 5s — check that availabilityProjection.js is running and connected to the same Redis stream/consumer group.');
    }

    // Step 3: Poll Booking History View
    console.log('\nStep 3: Polling GET /api/users/:userId/bookings for history update...');
    let histVisible = false;
    let histLag = 0;
    let histPollAttempts = 0;

    while (!histVisible && histPollAttempts < 100) {
      histPollAttempts++;
       const res = await fetch(`http://localhost:${port}/api/users/${userId}/bookings`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.status === 200) {
        const rows = await res.json();
        const booking = rows.find(r => r.stream_id === streamId);
        if (booking && booking.status === 'reserved') {
          histVisible = true;
          histLag = Date.now() - commandIssuedTime;
          console.log(`Success: Found in booking history view with status "reserved". Rows count: ${rows.length}`);
          break;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    if (!histVisible) {
      throw new Error('TIMEOUT: booking did not appear in booking_history_view after 5s — check that bookingHistoryProjection.js is running and connected to the same Redis stream/consumer group.');
    }

    // Log the synchronization lags
    console.log('\n--- Latency Performance Report ---');
    console.log(`Availability projection lag: ${availLag}ms (Polls: ${availPollAttempts})`);
    console.log(`Booking history projection lag: ${histLag}ms (Polls: ${histPollAttempts})`);
    console.log('----------------------------------');

  } finally {
    console.log('\nCleaning up resources...');
    
    // Kill child consumer processes gracefully
    console.log('Terminating projection consumers...');
    availProc.kill('SIGTERM');
    histProc.kill('SIGTERM');

    // Close server
    console.log('Stopping HTTP server...');
    await new Promise(resolve => server.close(resolve));

    // Close database pool and redis client
    console.log('Closing connections...');
    await publisherRedis.quit();
    await pool.end();
  }

  console.log('--- Phase 3 Verification Completed ---');
}

runTest().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
