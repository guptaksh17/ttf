import { execSync } from 'child_process';
import { pool } from '../src/eventStore.js';
import { seed } from '../seedReferenceData.js';
import { closeAll } from './testUtils/teardown.js';
import jwt from 'jsonwebtoken';

async function runChaosTest2b() {
  console.log('--- Chaos Test 2b: Redis Outage With Transactional Outbox Recovery ---');

  // 1. Seed reference data
  console.log('Seeding reference database...');
  await seed(pool);

  const courtRes = await pool.query("SELECT id FROM courts WHERE name = 'Court 1' LIMIT 1;");
  const userRes = await pool.query("SELECT id FROM users WHERE email = 'test-fixture-1@internal.test';");
  const courtId = courtRes.rows[0].id;
  const userId = userRes.rows[0].id;

  const token = jwt.sign({ id: userId, role: 'user' }, process.env.JWT_SECRET || 'taptoturf_secret');

  const bookingDate = '2026-12-05';
  const startHour = 18;

  // Cleanup past events for this slot
  await pool.query("DELETE FROM event_log WHERE payload->>'courtId' = $1 AND payload->>'bookingDate' = $2 AND (payload->>'startHour')::int = $3", [courtId, bookingDate, startHour]);
  await pool.query("TRUNCATE TABLE availability_view CASCADE;");
  await pool.query("TRUNCATE TABLE event_outbox CASCADE;");

  // 2. Stop Redis to simulate outage
  console.log('Stopping Redis service to simulate infrastructure outage...');
  execSync('brew services stop redis');
  await new Promise(resolve => setTimeout(resolve, 1000));

  // 3. Start containers. The command-api automatically runs the outbox relay in background.
  console.log('Starting command-api and availability-projection containers...');
  execSync('docker compose -f docker-compose.chaos.yml up -d command-api availability-projection');
  await new Promise(resolve => setTimeout(resolve, 2000));

  try {
    // 4. Fire booking reservation request
    console.log('Sending reservation request to decoupled command API while Redis is offline...');
    const startTime = performance.now();
    const reserveRes = await fetch('http://localhost:3000/api/bookings/reserve', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ courtId, userId, bookingDate, startHour, durationHours: 2 })
    });
    const duration = performance.now() - startTime;

    console.log(`Reservation response status: ${reserveRes.status}`);
    console.log(`Reservation API latency: ${duration.toFixed(2)}ms`);

    if (reserveRes.status !== 201) {
      throw new Error(`Expected reservation to succeed (201) despite Redis outage, but got ${reserveRes.status}`);
    }

    const { streamId } = await reserveRes.json();
    console.log(`Successfully reserved booking. Stream ID: ${streamId}`);

    // 5. Verify outbox table has an entry with published = false
    console.log('Querying event_outbox to check for unpublished events...');
    const outboxRes = await pool.query(
      `SELECT o.id, o.published, l.event_type 
       FROM event_outbox o
       JOIN event_log l ON o.event_log_id = l.id
       WHERE l.stream_id = $1`,
      [streamId]
    );

    console.log(`Outbox records found: ${outboxRes.rows.length}`);
    if (outboxRes.rows.length === 0) {
      throw new Error('Expected outbox record to exist, but found 0 rows!');
    }

    const outboxRecord = outboxRes.rows[0];
    console.log(`Outbox record details: ID=${outboxRecord.id}, event_type=${outboxRecord.event_type}, published=${outboxRecord.published}`);
    if (outboxRecord.published !== false) {
      throw new Error(`Expected published status to be false, but got ${outboxRecord.published}`);
    }
    console.log('Verified: Outbox record is correctly queued and marked as unpublished.');

    // 6. Wait and verify that the relay is logging failed attempts
    console.log('Waiting 3 seconds for the outbox relay to attempt publishing...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    console.log('Retrieving command-api container logs to verify retry logic...');
    const logs = execSync('docker logs command-api 2>&1').toString();
    const hasRetryLog = logs.includes('Failed to publish event') || logs.includes('Redis is likely unreachable') || logs.includes('Connection is closed');
    if (!hasRetryLog) {
      console.log('--- Container logs dump start ---');
      console.log(logs);
      console.log('--- Container logs dump end ---');
      throw new Error('Expected relay to log failed publishing attempts in command-api container, but did not find expected logs.');
    }
    console.log('Verified: Outbox relay is retrying publishing in the background and logging failures.');

    // Verify availability_view does NOT show the booking yet
    const viewRes = await pool.query('SELECT status FROM availability_view WHERE stream_id = $1', [streamId]);
    if (viewRes.rows.length > 0) {
      throw new Error('Unexpected: booking appeared in read view before Redis was restored!');
    }
    console.log('Verified: Booking is not in read view during outage.');

    // 7. Restart Redis
    console.log('Restoring Redis service...');
    execSync('brew services start redis');

    // 8. Poll and verify outbox status flips to published = true, and read view updates
    console.log('Polling outbox status and availability_view for automatic recovery...');
    let recovered = false;
    let pollCount = 0;
    while (!recovered && pollCount < 200) {
      pollCount++;
      const outboxCheck = await pool.query(
        `SELECT o.published 
         FROM event_outbox o
         JOIN event_log l ON o.event_log_id = l.id
         WHERE l.stream_id = $1`,
        [streamId]
      );
      const viewCheck = await pool.query('SELECT status FROM availability_view WHERE stream_id = $1', [streamId]);

      const isPublished = outboxCheck.rows[0]?.published;
      const viewStatus = viewCheck.rows[0]?.status;

      if (isPublished === true && viewStatus === 'reserved') {
        recovered = true;
        console.log(`SUCCESS: Outbox relay recovered and updated read view automatically!`);
        console.log(`Relay status: published=${isPublished}, Read View status: ${viewStatus}`);
        break;
      }

      await new Promise(resolve => setTimeout(resolve, 100));
    }

    if (!recovered) {
      throw new Error('TIMEOUT: relay failed to publish and reconcile the projections automatically.');
    }

    // 9. Before / After Comparison Log
    console.log('\n================================================================');
    console.log('COMPARISON: ORIGINAL REDIS OUTAGE GAP VS TRANSACTIONAL OUTBOX');
    console.log('----------------------------------------------------------------');
    console.log('1. ORIGINAL GAP (Chaos Test 2):');
    console.log('   - Redis went offline, HTTP write completed.');
    console.log('   - Event was permanently missing from Redis stream.');
    console.log('   - Read projections remained permanently out-of-sync.');
    console.log('   - Required manual developer intervention (rebuildProjection.js).');
    console.log('2. TRANSACTIONAL OUTBOX SOLUTION (Chaos Test 2b):');
    console.log('   - Redis went offline, HTTP write completed.');
    console.log('   - Event was saved atomically to Postgres outbox queue.');
    console.log('   - Relay logged retries while Redis was offline.');
    console.log('   - Redis was restored.');
    console.log('   - Relay processed queue and caught up projections automatically.');
    console.log('   - ZERO manual intervention required.');
    console.log('================================================================\n');

  } finally {
    // 10. Cleanup
    console.log('Ensuring Redis is started...');
    execSync('brew services start redis');
    console.log('Stopping containers...');
    try {
      execSync('docker compose -f docker-compose.chaos.yml down');
    } catch (e) {
      console.error(e);
    }
    await closeAll({ pool });
    console.log('--- Chaos Test 2b Passed Successfully ---');
  }

  // Diagnostics
  console.log('Active handles:', process._getActiveHandles().map(h => h.constructor.name));
  process.exit(0);
}

runChaosTest2b().catch(async (err) => {
  console.error('Chaos Test 2b FAILED:', err);
  execSync('brew services start redis');
  await closeAll({ pool });
  process.exit(1);
});
