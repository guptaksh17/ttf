import crypto from 'crypto';
import { seed } from './seedReferenceData.js';
import { pool, appendEvent, ConcurrencyError } from './src/eventStore.js';
import { EVENTS, rebuildState } from './src/bookingAggregate.js';

async function runTest() {
  console.log('--- TapToTurf Phase 1 Verification Script ---');

  // 1. Run/Import seedReferenceData.js first
  console.log('Step 1: Seeding reference data...');
  await seed(pool);

  // 2. Fetch the real "Court 1" and a real user ID from the database
  console.log('Step 2: Fetching Court 1 and User from reference data...');
  const courtRes = await pool.query("SELECT id, base_price_per_hour FROM courts WHERE name = 'Court 1' LIMIT 1;");
  const userRes = await pool.query("SELECT id FROM users WHERE email = 'test-fixture-1@internal.test';");

  if (courtRes.rows.length === 0 || userRes.rows.length === 0) {
    throw new Error('Failed to fetch seeded Court 1 or User from database.');
  }

  const courtId = courtRes.rows[0].id;
  const basePricePerHour = parseFloat(courtRes.rows[0].base_price_per_hour);
  const userId = userRes.rows[0].id;

  console.log(`Fetched Court 1 ID: ${courtId} (Base price: ${basePricePerHour})`);
  console.log(`Fetched User ID: ${userId}`);

  // 3. Create a new streamId representing one booking transaction
  const streamId = crypto.randomUUID();
  console.log(`Step 3: Created booking stream ID: ${streamId}`);

  // Calculate 30 days from now
  const targetDate = new Date();
  targetDate.setDate(targetDate.getDate() + 30);
  const bookingDate = targetDate.toISOString().split('T')[0];

  // Reservation expiration date (5 minutes from now)
  const reservationExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  const durationHours = 2;
  const totalAmount = basePricePerHour * durationHours;

  console.log(`Booking parameters: Date=${bookingDate}, Duration=${durationHours}h, Total=${totalAmount}`);

  // 4. Append events in sequence: v1, v2, v3, v4
  console.log('Step 4: Appending events sequentially...');

  // v1: SLOTS_RESERVED
  console.log('Appending SLOTS_RESERVED...');
  await appendEvent(
    streamId,
    0, // expectedVersion = 0, inserts version 1
    EVENTS.SLOTS_RESERVED,
    {
      courtId,
      userId,
      bookingDate,
      startHour: 18,
      durationHours,
      totalAmount,
      reservationExpiresAt
    },
    { correlation_id: crypto.randomUUID() }
  );

  // v2: PAYMENT_INITIATED
  console.log('Appending PAYMENT_INITIATED...');
  await appendEvent(
    streamId,
    1, // expectedVersion = 1, inserts version 2
    EVENTS.PAYMENT_INITIATED,
    {},
    { correlation_id: crypto.randomUUID() }
  );

  // v3: PAYMENT_CONFIRMED
  console.log('Appending PAYMENT_CONFIRMED...');
  await appendEvent(
    streamId,
    2, // expectedVersion = 2, inserts version 3
    EVENTS.PAYMENT_CONFIRMED,
    {},
    { correlation_id: crypto.randomUUID() }
  );

  // v4: BOOKING_CONFIRMED
  console.log('Appending BOOKING_CONFIRMED...');
  await appendEvent(
    streamId,
    3, // expectedVersion = 3, inserts version 4
    EVENTS.BOOKING_CONFIRMED,
    {},
    { correlation_id: crypto.randomUUID() }
  );

  // 5. Rebuild booking state
  console.log('Step 5: Rebuilding Booking Aggregate State...');
  const finalState = await rebuildState(streamId);
  console.log('Rebuilt State:', finalState);

  // Validate state
  if (finalState.status !== 'booking_confirmed') {
    throw new Error(`State validation failed: expected status 'booking_confirmed', got '${finalState.status}'`);
  }
  if (finalState.courtId !== courtId) {
    throw new Error(`State validation failed: expected courtId '${courtId}', got '${finalState.courtId}'`);
  }
  if (finalState.bookingDate !== bookingDate) {
    throw new Error(`State validation failed: expected bookingDate '${bookingDate}', got '${finalState.bookingDate}'`);
  }
  if (finalState.startHour !== 18) {
    throw new Error(`State validation failed: expected startHour 18, got ${finalState.startHour}`);
  }
  if (finalState.durationHours !== durationHours) {
    throw new Error(`State validation failed: expected durationHours ${durationHours}, got ${finalState.durationHours}`);
  }
  if (finalState.totalAmount !== totalAmount) {
    throw new Error(`State validation failed: expected totalAmount ${totalAmount}, got ${finalState.totalAmount}`);
  }
  if (finalState.version !== 4) {
    throw new Error(`State validation failed: expected version 4, got ${finalState.version}`);
  }

  console.log('SUCCESS: Rebuilt Booking Aggregate State is correct!');

  // 6. Deliberately attempt to re-append version 2 to trigger ConcurrencyError
  console.log('Step 6: Simulating concurrency conflict by attempting to re-append version 2...');
  try {
    // Attempting to append with expectedVersion = 1, which tries to insert version 2.
    // Version 2 already exists on this stream.
    await appendEvent(
      streamId,
      1,
      EVENTS.PAYMENT_INITIATED,
      { note: 'This should fail due to concurrency version conflict' }
    );
    throw new Error('FAIL: Concurrency conflict was expected to throw, but it succeeded.');
  } catch (error) {
    if (error instanceof ConcurrencyError) {
      console.log('SUCCESS: Caught ConcurrencyError as expected!');
      console.log('Error Name:', error.name);
      console.log('Error Message:', error.message);
      console.log('Conflicting streamId:', error.streamId);
      console.log('Conflicting version:', error.version);
    } else {
      console.error('FAIL: An unexpected error was thrown:');
      throw error;
    }
  }

  console.log('\n--- All Tests Passed Successfully! ---');
}

runTest()
  .catch((err) => {
    console.error('Test execution failed with error:', err);
    process.exit(1);
  })
  .finally(async () => {
    console.log('Closing database connection pool...');
    await pool.end();
  });
