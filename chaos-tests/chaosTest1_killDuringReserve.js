import { execSync } from 'child_process';
import { pool } from '../src/eventStore.js';
import { seed } from '../seedReferenceData.js';
import { closeAll } from './testUtils/teardown.js';
import jwt from 'jsonwebtoken';

async function runChaosTest1() {
  console.log('--- Chaos Test 1: Kill Command API Mid-Transaction ---');

  // 1. Seed reference data
  console.log('Seeding reference database...');
  await seed(pool);

  const courtRes = await pool.query("SELECT id FROM courts WHERE name = 'Court 1' LIMIT 1;");
  const userRes = await pool.query("SELECT id FROM users WHERE email = 'test-fixture-1@internal.test';");
  const courtId = courtRes.rows[0].id;
  const userId = userRes.rows[0].id;

  const token = jwt.sign({ id: userId, role: 'user' }, process.env.JWT_SECRET || 'taptoturf_secret');

  const bookingDate = '2026-12-01';
  const startHour = 18;

  // Cleanup past events for this slot
  await pool.query("DELETE FROM event_log WHERE payload->>'courtId' = $1 AND payload->>'bookingDate' = $2 AND (payload->>'startHour')::int = $3", [courtId, bookingDate, startHour]);

  // 2. Start command-api container with a 3-second artificial delay
  console.log('Starting command-api container with 3000ms delay...');
  execSync('TEST_ARTIFICIAL_DELAY_MS=3000 docker compose -f docker-compose.chaos.yml up -d command-api');

  // Wait for it to become ready
  console.log('Waiting for container to start...');
  await new Promise(resolve => setTimeout(resolve, 2000));

  // 3. Send booking request in flight
  console.log('Sending reservation request...');
  const fetchPromise = fetch('http://localhost:3000/api/bookings/reserve', {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ courtId, userId, bookingDate, startHour, durationHours: 2 })
  }).catch(err => {
    console.log(`Fetch aborted/disconnected as expected: ${err.message}`);
    return null;
  });

  // 4. Wait 1000ms, then kill the container while the request is in flight
  await new Promise(resolve => setTimeout(resolve, 1000));
  console.log('Killing command-api container mid-transaction...');
  execSync('docker kill command-api');

  // Wait for fetch to settle
  await fetchPromise;

  // 5. Query Postgres to verify atomic consistency
  console.log('Querying database to check transaction outcome...');
  const checkRes = await pool.query(
    "SELECT id, version, event_type, payload FROM event_log WHERE payload->>'courtId' = $1 AND payload->>'bookingDate' = $2 AND (payload->>'startHour')::int = $3",
    [courtId, bookingDate, startHour]
  );

  const rowCount = checkRes.rows.length;
  console.log(`Database rows found: ${rowCount}`);

  if (rowCount === 0) {
    console.log('Outcome: Transaction successfully rolled back (0 rows).');
  } else if (rowCount === 1) {
    console.log('Outcome: Transaction successfully committed before the process was killed (1 complete row).');
    const row = checkRes.rows[0];
    console.log(`Event details: ID=${row.id}, Version=${row.version}, Type=${row.event_type}`);
  } else {
    throw new Error(`CRITICAL: Found multiple or corrupt rows in event_log for the slot! Count: ${rowCount}`);
  }

  // 6. Restart command-api container without delay
  console.log('Restarting command-api without delay to check lock release...');
  execSync('TEST_ARTIFICIAL_DELAY_MS=0 docker compose -f docker-compose.chaos.yml up -d command-api');
  await new Promise(resolve => setTimeout(resolve, 2000));

  // 7. Fire a new reservation attempt for the same slot
  console.log('Sending new reservation request for the same slot...');
  const newRes = await fetch('http://localhost:3000/api/bookings/reserve', {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ courtId, userId, bookingDate, startHour, durationHours: 2 })
  });

  console.log(`New request status code: ${newRes.status}`);

  if (rowCount === 0) {
    // If the killed one rolled back, this one MUST succeed
    if (newRes.status !== 201) {
      throw new Error(`Expected success (201) since initial request rolled back, but got ${newRes.status}`);
    }
    console.log('SUCCESS: Initial transaction rolled back, and second reservation succeeded!');
  } else {
    // If the killed one committed, this one MUST fail with 409
    if (newRes.status !== 409) {
      throw new Error(`Expected conflict (409) since initial request committed, but got ${newRes.status}`);
    }
    console.log('SUCCESS: Initial transaction committed, and second reservation failed with 409 conflict!');
  }

  try {
    // 8. Cleanup
    console.log('Stopping containers...');
    execSync('docker compose -f docker-compose.chaos.yml down');
  } finally {
    await closeAll({ pool });
  }

  console.log('--- Chaos Test 1 Passed Successfully ---');

  // Diagnostics
  console.log('Active handles:', process._getActiveHandles().map(h => h.constructor.name));
  process.exit(0);
}

runChaosTest1().catch(async (err) => {
  console.error('Chaos Test 1 FAILED:', err);
  await closeAll({ pool });
  process.exit(1);
});
