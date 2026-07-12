import jwt from 'jsonwebtoken';
import { pool } from './src/eventStore.js';
import { app } from './src/server.js';
import { seed } from './seedReferenceData.js';
import { redis as publisherRedis } from './src/eventPublisher.js';

async function runAdjacentTest() {
  console.log('--- TapToTurf Phase 2 Adjacent Bookings Test ---');

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

  try {
    // Truncate event_log to ensure a pristine starting state
    console.log('Truncating event_log table...');
    await pool.query('TRUNCATE TABLE event_log CASCADE;');

    const bookingDate = '2026-09-02';

    // 1. Book Court 1, date X, startHour=18, duration=2 (occupies 18:00 - 20:00)
    console.log('Booking 18:00 - 20:00 (expected success)...');
    const res1 = await fetch(`http://localhost:${port}/api/bookings/reserve`, {
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
    
    if (res1.status !== 201) {
      const text = await res1.text();
      throw new Error(`Failed to book initial slot. Status: ${res1.status}. Response: ${text}`);
    }
    const data1 = await res1.json();
    console.log(`Initial booking successful. Stream ID: ${data1.streamId}`);

    // 2. Attempt to book Court 1, date X, startHour=20, duration=1 (occupies 20:00 - 21:00) - ADJACENT, should succeed!
    console.log('Booking adjacent 20:00 - 21:00 (expected success)...');
    const res2 = await fetch(`http://localhost:${port}/api/bookings/reserve`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        courtId,
        userId,
        bookingDate,
        startHour: 20,
        durationHours: 1
      })
    });

    if (res2.status !== 201) {
      const text = await res2.text();
      throw new Error(`Assertion FAILED: Adjacent booking failed. Status: ${res2.status}. Response: ${text}`);
    }
    const data2 = await res2.json();
    console.log(`Adjacent booking successful. Stream ID: ${data2.streamId}`);

    // 3. Attempt Court 1, date X, startHour=19, duration=1 (occupies 19:00 - 20:00) - OVERLAPS first booking, should fail with 409!
    console.log('Booking overlapping 19:00 - 20:00 (expected conflict/409)...');
    const res3 = await fetch(`http://localhost:${port}/api/bookings/reserve`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        courtId,
        userId,
        bookingDate,
        startHour: 19,
        durationHours: 1
      })
    });

    console.log(`Overlapping booking response status: ${res3.status}`);
    if (res3.status !== 409) {
      const text = await res3.text();
      throw new Error(`Assertion FAILED: Expected 409 Conflict for overlapping slot, got status ${res3.status}. Response: ${text}`);
    }
    const data3 = await res3.json();
    console.log('Response body:', data3);

    console.log('\nSUCCESS: Adjacent booking tests passed successfully!');

  } finally {
    console.log('Shutting down server, database pool, and redis publisher...');
    await new Promise(resolve => server.close(resolve));
    await pool.end();
    await publisherRedis.quit();
  }
}

runAdjacentTest().catch((err) => {
  console.error('Adjacent test failed:', err);
  process.exit(1);
});
