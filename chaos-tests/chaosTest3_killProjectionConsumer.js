import { execSync } from 'child_process';
import { pool } from '../src/eventStore.js';
import { seed } from '../seedReferenceData.js';
import { closeAll } from './testUtils/teardown.js';
import jwt from 'jsonwebtoken';

async function runChaosTest3() {
  console.log('--- Chaos Test 3: Kill Projection Consumer Mid-Stream ---');

  // 1. Seed reference data
  console.log('Seeding reference database...');
  await seed(pool);

  const courtRes = await pool.query("SELECT id FROM courts WHERE name = 'Court 1' LIMIT 1;");
  const userRes = await pool.query("SELECT id FROM users WHERE email = 'test-fixture-1@internal.test';");
  const courtId = courtRes.rows[0].id;
  const userId = userRes.rows[0].id;

  const token = jwt.sign({ id: userId, role: 'user' }, process.env.JWT_SECRET || 'taptoturf_secret');

  const bookingDate = '2026-12-03';

  // Cleanup past events
  await pool.query("DELETE FROM event_log WHERE payload->>'courtId' = $1 AND payload->>'bookingDate' = $2", [courtId, bookingDate]);
  await pool.query("TRUNCATE TABLE availability_view CASCADE;");

  // 2. Start command-api and availability-projection
  console.log('Starting command-api and availability-projection...');
  execSync('docker compose -f docker-compose.chaos.yml up -d command-api availability-projection');
  await new Promise(resolve => setTimeout(resolve, 2000));

  try {
    // 3. Fire 3 reservations while consumer is healthy
    console.log('Firing initial 3 reservations...');
    const streamIds = [];
    for (let i = 0; i < 3; i++) {
      const res = await fetch('http://localhost:3000/api/bookings/reserve', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ courtId, userId, bookingDate, startHour: 10 + i * 2, durationHours: 2 })
      });
      const { streamId } = await res.json();
      streamIds.push(streamId);
    }

    // Wait until they are visible in availability_view
    console.log('Waiting for availability-projection to consume first 3 events...');
    let initialSync = false;
    let pollCount = 0;
    while (!initialSync && pollCount < 100) {
      pollCount++;
      const res = await pool.query('SELECT COUNT(*) FROM availability_view WHERE status = \'reserved\'');
      const count = parseInt(res.rows[0].count, 10);
      if (count === 3) {
        initialSync = true;
        console.log('Baseline check: Initial 3 bookings are active and synced.');
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    if (!initialSync) {
      throw new Error('TIMEOUT: initial 3 bookings were not synced by the consumer.');
    }

    // 4. Kill the projection consumer
    console.log('Killing availability-projection container mid-stream...');
    const containerId = execSync('docker compose -f docker-compose.chaos.yml ps -q availability-projection').toString().trim().split('\n')[0];
    execSync(`docker kill ${containerId}`);

    // 5. Fire 3 MORE reservations while consumer is dead
    console.log('Firing 3 more reservations while consumer is offline...');
    for (let i = 3; i < 6; i++) {
      const res = await fetch('http://localhost:3000/api/bookings/reserve', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ courtId, userId, bookingDate, startHour: 10 + i * 2, durationHours: 2 })
      });
      const { streamId } = await res.json();
      streamIds.push(streamId);
    }

    // Verify availability_view still has only 3 rows
    console.log('Verifying availability_view has not updated while consumer is offline...');
    const checkRes = await pool.query('SELECT COUNT(*) FROM availability_view');
    const checkCount = parseInt(checkRes.rows[0].count, 10);
    console.log(`Current rows count: ${checkCount}`);
    if (checkCount !== 3) {
      throw new Error(`Expected read view count to stay at 3, but got ${checkCount}`);
    }

    // 6. Restart the projection consumer
    console.log('Restarting availability-projection container...');
    const restartStart = performance.now();
    execSync('docker compose -f docker-compose.chaos.yml up -d availability-projection');

    // 7. Poll and verify it catches up on pending stream events
    console.log('Waiting for consumer to catch up and process the 3 pending bookings...');
    let finalSync = false;
    pollCount = 0;
    while (!finalSync && pollCount < 100) {
      pollCount++;
      const res = await pool.query('SELECT COUNT(*) FROM availability_view WHERE status = \'reserved\'');
      const count = parseInt(res.rows[0].count, 10);
      if (count === 6) {
        finalSync = true;
        const catchupTime = performance.now() - restartStart;
        console.log(`SUCCESS: Catch-up completed successfully!`);
        console.log(`Catch-up time: ${catchupTime.toFixed(2)}ms`);
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    if (!finalSync) {
      throw new Error('TIMEOUT: consumer failed to catch up on pending stream events.');
    }

    // Verify zero duplicate processing / exact row matching
    const rowCheck = await pool.query('SELECT COUNT(*) FROM availability_view');
    const rowCount = parseInt(rowCheck.rows[0].count, 10);
    if (rowCount !== 6) {
      throw new Error(`Integrity check FAILED: expected exactly 6 rows, found ${rowCount}`);
    }
    console.log('Verified: Integrity checks pass with 0 duplicates and 0 skipped events.');

  } finally {
    // 8. Cleanup
    console.log('Stopping containers...');
    try {
      execSync('docker compose -f docker-compose.chaos.yml down');
    } catch (e) {
      console.error('Docker compose down failed:', e);
    }
    await closeAll({ pool });
  }

  console.log('--- Chaos Test 3 Passed Successfully ---');

  // Diagnostics
  console.log('Active handles:', process._getActiveHandles().map(h => h.constructor.name));
  process.exit(0);
}

runChaosTest3().catch(async (err) => {
  console.error('Chaos Test 3 FAILED:', err);
  await closeAll({ pool });
  process.exit(1);
});
