import { execSync } from 'child_process';
import { pool } from '../src/eventStore.js';
import { app } from '../src/server.js';
import { seed } from '../seedReferenceData.js';
import { redis as publisherRedis } from '../src/eventPublisher.js';
import { closeAll } from './testUtils/teardown.js';
import jwt from 'jsonwebtoken';

async function runChaosTest4() {
  console.log('--- Chaos Test 4: Advisory Lock Holder Connection Terminated ---');

  // 1. Seed reference data
  console.log('Seeding reference database...');
  await seed(pool);

  const courtRes = await pool.query("SELECT id FROM courts WHERE name = 'Court 1' LIMIT 1;");
  const userRes = await pool.query("SELECT id FROM users WHERE email = 'test-fixture-1@internal.test';");
  const courtId = courtRes.rows[0].id;
  const userId = userRes.rows[0].id;

  const token = jwt.sign({ id: userId, role: 'user' }, process.env.JWT_SECRET || 'taptoturf_secret');

  const bookingDate = '2026-12-04';
  const startHour = 18;

  // Cleanup past events for this slot
  await pool.query("DELETE FROM event_log WHERE payload->>'courtId' = $1 AND payload->>'bookingDate' = $2 AND (payload->>'startHour')::int = $3", [courtId, bookingDate, startHour]);

  // 2. Start container command-api with a 4-second artificial delay
  console.log('Starting command-api container with 4000ms delay...');
  execSync('TEST_ARTIFICIAL_DELAY_MS=4000 docker compose -f docker-compose.chaos.yml up -d command-api');
  await new Promise(resolve => setTimeout(resolve, 2000));

  // 3. Fire first request to the container (holds the lock)
  console.log('Sending first reservation request to container...');
  const containerFetch = fetch('http://localhost:3000/api/bookings/reserve', {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ courtId, userId, bookingDate, startHour, durationHours: 2 })
  }).catch(err => {
    console.log(`Container fetch disconnected as expected: ${err.message}`);
    return null;
  });

  // Wait 1500ms to ensure the container has acquired the Postgres advisory lock
  await new Promise(resolve => setTimeout(resolve, 1500));

  let localServer;
  try {
    // 4. Kill the container while it holds the lock
    console.log('Killing command-api container (terminating Postgres connection)...');
    execSync('docker kill command-api');

    // 5. Start a local server on the host (ephemeral port) to act as a secondary node
    console.log('Starting local Express node on ephemeral port to handle fallback request...');
    localServer = app.listen(0);
    await new Promise(resolve => localServer.once('listening', resolve));
    const localPort = localServer.address().port;
    console.log(`Local Express node listening on port ${localPort}`);

    // 6. Immediately fire second request to local server for the same slot
    console.log('Immediately sending second reservation request to local host server...');
    const start = performance.now();
    const localFetch = await fetch(`http://localhost:${localPort}/api/bookings/reserve`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ courtId, userId, bookingDate, startHour, durationHours: 2 })
    });
    const duration = performance.now() - start;

    console.log(`Local reservation response status: ${localFetch.status}`);
    console.log(`Lock release detection latency: ${duration.toFixed(2)}ms`);

    // Verify lock was released instantly and second request succeeded
    if (localFetch.status !== 201) {
      throw new Error(`Expected second request to succeed (201) because the first rolled back on connection termination, but got ${localFetch.status}`);
    }
    console.log('SUCCESS: Postgres session advisory lock auto-released immediately on connection kill, preventing deadlocks!');

  } finally {
    // 7. Cleanup
    console.log('Stopping local server and Docker containers...');
    try {
      execSync('docker compose -f docker-compose.chaos.yml down');
    } catch (e) {
      console.error('Docker compose down failed:', e);
    }
    await closeAll({ server: localServer, pool, publisherRedis });
  }

  console.log('--- Chaos Test 4 Passed Successfully ---');

  // Diagnostics
  console.log('Active handles:', process._getActiveHandles().map(h => h.constructor.name));
  process.exit(0);
}

runChaosTest4().catch(async (err) => {
  console.error('Chaos Test 4 FAILED:', err);
  await closeAll({ pool, publisherRedis });
  process.exit(1);
});
