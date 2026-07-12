import { execSync } from 'child_process';
import { pool } from '../src/eventStore.js';
import { seed } from '../seedReferenceData.js';
import { closeAll } from './testUtils/teardown.js';
import jwt from 'jsonwebtoken';

async function runChaosTest2() {
  console.log('--- Chaos Test 2: Redis Outage During Active Booking Flow ---');

  // 1. Seed reference data
  console.log('Seeding reference database...');
  await seed(pool);

  const courtRes = await pool.query("SELECT id FROM courts WHERE name = 'Court 1' LIMIT 1;");
  const userRes = await pool.query("SELECT id FROM users WHERE email = 'test-fixture-1@internal.test';");
  const courtId = courtRes.rows[0].id;
  const userId = userRes.rows[0].id;

  const token = jwt.sign({ id: userId, role: 'user' }, process.env.JWT_SECRET || 'taptoturf_secret');

  const bookingDate = '2026-12-02';
  const startHour = 18;

  // Cleanup past events for this slot
  await pool.query("DELETE FROM event_log WHERE payload->>'courtId' = $1 AND payload->>'bookingDate' = $2 AND (payload->>'startHour')::int = $3", [courtId, bookingDate, startHour]);
  await pool.query("TRUNCATE TABLE availability_view CASCADE;");

  // 2. Start containers while Redis is running
  console.log('Ensuring Redis is started...');
  execSync('brew services start redis');
  await new Promise(resolve => setTimeout(resolve, 1000));

  console.log('Starting command-api and availability-projection containers with outbox relay disabled...');
  execSync('DISABLE_OUTBOX_RELAY=true docker compose -f docker-compose.chaos.yml up -d command-api availability-projection');
  await new Promise(resolve => setTimeout(resolve, 2000));

  try {
    // 3. Stop Redis to simulate outage
    console.log('Stopping Redis service to simulate infrastructure outage...');
    execSync('brew services stop redis');
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 4. Fire booking reservation request
    console.log('Sending reservation request while Redis is offline (Postgres is online)...');
    const reserveRes = await fetch('http://localhost:3000/api/bookings/reserve', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ courtId, userId, bookingDate, startHour, durationHours: 2 })
    });

    console.log(`Reservation response status: ${reserveRes.status}`);
    if (reserveRes.status !== 201) {
      throw new Error(`Expected reservation to succeed (201) despite Redis outage, but got ${reserveRes.status}`);
    }

    const { streamId } = await reserveRes.json();
    console.log(`Successfully reserved booking. Stream ID: ${streamId}`);

    // Verify Postgres has the event
    const pgRes = await pool.query('SELECT version FROM event_log WHERE stream_id = $1', [streamId]);
    console.log(`Verified Postgres event count for stream: ${pgRes.rows.length}`);
    if (pgRes.rows.length === 0) {
      throw new Error('Expected event to be written to Postgres, but found 0 rows!');
    }

    // 5. Verify availability_view does NOT show this booking
    console.log('Checking availability_view for the booking...');
    const viewRes = await pool.query('SELECT status FROM availability_view WHERE stream_id = $1', [streamId]);
    console.log(`Availability view row count: ${viewRes.rows.length}`);
    if (viewRes.rows.length > 0) {
      throw new Error('Expected booking to be missing from availability_view since Redis is down, but it was found!');
    }
    console.log('Verified: Booking is missing from the read view as expected.');

    // 6. Restore Redis connectivity
    console.log('Restoring Redis service...');
    execSync('brew services start redis');
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Verify availability_view STILL does not show it (event lost in transit)
    const postRestoreRes = await pool.query('SELECT status FROM availability_view WHERE stream_id = $1', [streamId]);
    if (postRestoreRes.rows.length > 0) {
      throw new Error('Unexpected: Booking appeared in read view after Redis restore without rebuild. This implies event was not lost!');
    }
    console.log('Verified gap: Booking remains missing from read view after Redis restoration.');

    // 7. Demonstrate mitigation: run rebuildProjection.js
    console.log('Running rebuildProjection.js to reconcile read model from event log source of truth...');
    execSync('node src/projections/rebuildProjection.js availability');

    // 8. Verify booking now appears correctly in the read view
    console.log('Rechecking availability_view post-rebuild...');
    const finalRes = await pool.query('SELECT status FROM availability_view WHERE stream_id = $1', [streamId]);
    if (finalRes.rows.length === 0 || finalRes.rows[0].status !== 'reserved') {
      throw new Error(`Expected booking to be present with status 'reserved' after rebuild, but got: ${JSON.stringify(finalRes.rows)}`);
    }
    console.log('SUCCESS: Read view fully restored and synced post-rebuild!');

  } finally {
    // 9. Cleanup
    console.log('Restoring Redis service status...');
    execSync('brew services start redis');
    console.log('Stopping containers...');
    try {
      execSync('docker compose -f docker-compose.chaos.yml down');
    } catch (e) {
      console.error('Docker compose down failed:', e);
    }
    await closeAll({ pool });
  }

  console.log('--- Chaos Test 2 Passed Successfully ---');

  // Diagnostics
  console.log('Active handles:', process._getActiveHandles().map(h => h.constructor.name));
  process.exit(0);
}

runChaosTest2().catch(async (err) => {
  console.error('Chaos Test 2 FAILED:', err);
  execSync('brew services start redis');
  await closeAll({ pool });
  process.exit(1);
});
