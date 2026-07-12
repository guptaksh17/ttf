import jwt from 'jsonwebtoken';
import { pool } from './src/eventStore.js';
import { app } from './src/server.js';
import { seed } from './seedReferenceData.js';
import { redis as publisherRedis } from './src/eventPublisher.js';

async function runRaceTest() {
  console.log('--- TapToTurf Phase 2 Concurrency Race Test ---');

  // 1. Seed database and retrieve test data
  console.log('Seeding database...');
  await seed(pool);

  const courtRes = await pool.query("SELECT id FROM courts WHERE name = 'Court 1' LIMIT 1;");
  const userRes = await pool.query("SELECT id FROM users WHERE email = 'test-fixture-1@internal.test';");

  if (courtRes.rows.length === 0 || userRes.rows.length === 0) {
    throw new Error('Failed to retrieve Court 1 or User ID from database.');
  }

  const courtId = courtRes.rows[0].id;
  const userId = userRes.rows[0].id;
  const token = jwt.sign({ id: userId, role: 'user' }, process.env.JWT_SECRET || 'taptoturf_secret', { expiresIn: '1d' });

  // 2. Start the Express server on an ephemeral port
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port;
  console.log(`Test server started on ephemeral port: ${port}`);

  const totalRuns = 3;

  try {
    for (let run = 1; run <= totalRuns; run++) {
      console.log(`\n--- Race Run ${run} of ${totalRuns} ---`);

      // Truncate event_log to clear old state and make run independent
      console.log('Truncating event_log table...');
      await pool.query('TRUNCATE TABLE event_log CASCADE;');

      const bookingDate = '2026-09-01'; // Constant date for testing

      console.log(`Firing 20 simultaneous reservation requests for Court ${courtId} on ${bookingDate} at 18:00...`);

      const requests = Array.from({ length: 20 }, () => {
        return fetch(`http://localhost:${port}/api/bookings/reserve`, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({
            courtId,
            userId,
            bookingDate,
            startHour: 18,
            durationHours: 2
          })
        });
      });

      const responses = await Promise.all(requests);

      let successCount = 0;
      let conflictCount = 0;
      let errorCount = 0;

      for (const res of responses) {
        if (res.status === 201) {
          successCount++;
        } else if (res.status === 409) {
          conflictCount++;
        } else {
          errorCount++;
          const body = await res.text();
          console.error(`Unexpected response status ${res.status}: ${body}`);
        }
      }

      console.log(`Results: Success (201) = ${successCount}, Conflict (409) = ${conflictCount}, Errors = ${errorCount}`);

      if (successCount !== 1) {
        throw new Error(`Assertion FAILED: Expected exactly 1 success, got ${successCount}`);
      }

      if (conflictCount !== 19) {
        throw new Error(`Assertion FAILED: Expected exactly 19 conflicts, got ${conflictCount}`);
      }

      if (errorCount !== 0) {
        throw new Error(`Assertion FAILED: Expected 0 errors, got ${errorCount}`);
      }

      console.log(`Run ${run} passed successfully!`);
    }

    console.log('\nSUCCESS: All race tests passed successfully without flakiness!');
  } finally {
    console.log('Shutting down server, database pool, and redis publisher...');
    console.log(`Pool Diagnostics - Total Clients: ${pool.totalCount}, Idle Clients: ${pool.idleCount}, Waiting Clients: ${pool.waitingCount}`);
    await new Promise(resolve => server.close(resolve));
    await pool.end();
    await publisherRedis.quit();
  }
}

runRaceTest().catch((err) => {
  console.error('Race test failed:', err);
  process.exit(1);
});
