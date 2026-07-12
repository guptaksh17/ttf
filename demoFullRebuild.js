import { pool, getAllEvents } from './src/eventStore.js';
import { handleAvailabilityEvent } from './src/projections/availabilityProjection.js';
import { handleBookingHistoryEvent } from './src/projections/bookingHistoryProjection.js';

async function runDemo() {
  console.log('=== TapToTurf Phase 5: CQRS Full Projection Rebuild Demo ===');
  console.log('This script demonstrates the core CQRS tenet: read models are completely');
  console.log('disposable and can be fully rebuilt from the immutable event log at any time.\n');

  // 1. Sync views to baseline first to account for unprocessed benchmark/synthetic events
  console.log('Pre-flight: Truncating views and re-syncing from log to clean any orphans...');
  await pool.query('TRUNCATE TABLE availability_view, booking_history_view CASCADE;');
  const baselineEvents = await getAllEvents();
  for (const event of baselineEvents) {
    await handleAvailabilityEvent(event, pool);
    await handleBookingHistoryEvent(event, pool);
  }
  console.log('Pre-flight: Read views are fully synced with the event log baseline.\n');

  // 1. Get initial row counts
  console.log('Step 1: Reading baseline read-model state from database...');
  const initialAvailRes = await pool.query('SELECT COUNT(*) FROM availability_view');
  const initialHistRes = await pool.query('SELECT COUNT(*) FROM booking_history_view');
  const initialAvail = parseInt(initialAvailRes.rows[0].count, 10);
  const initialHist = parseInt(initialHistRes.rows[0].count, 10);
  console.log(`- Baseline rows in availability_view: ${initialAvail}`);
  console.log(`- Baseline rows in booking_history_view: ${initialHist}\n`);

  // 2. Truncate target tables
  console.log('Step 2: Simulating data loss/corruption (TRUNCATING both views)...');
  await pool.query('TRUNCATE TABLE availability_view, booking_history_view CASCADE;');
  console.log('Availability and booking history views have been emptied.');

  // Confirm truncation
  const checkAvail = await pool.query('SELECT COUNT(*) FROM availability_view');
  const checkHist = await pool.query('SELECT COUNT(*) FROM booking_history_view');
  console.log(`- Verified rows in availability_view: ${checkAvail.rows[0].count}`);
  console.log(`- Verified rows in booking_history_view: ${checkHist.rows[0].count}\n`);

  // 3. Fetch full event log
  console.log('Step 3: Fetching the complete immutable event log...');
  const events = await getAllEvents();
  console.log(`Successfully fetched ${events.length} events from event_log.\n`);

  // 4. Replay events sequentially
  console.log('Step 4: Replaying events through projection apply handlers...');
  const start = performance.now();
  let processed = 0;

  for (const event of events) {
    // Replay through both projection views
    await handleAvailabilityEvent(event, pool);
    await handleBookingHistoryEvent(event, pool);

    processed++;
    if (processed % 500 === 0) {
      console.log(`Progress: Replayed ${processed}/${events.length} events...`);
    }
  }

  const duration = performance.now() - start;
  console.log(`\nReplay completed! Replayed ${processed} events in ${duration.toFixed(2)}ms.\n`);

  // 5. Verify restored counts
  console.log('Step 5: Verifying restored database state...');
  const finalAvailRes = await pool.query('SELECT COUNT(*) FROM availability_view');
  const finalHistRes = await pool.query('SELECT COUNT(*) FROM booking_history_view');
  const finalAvail = parseInt(finalAvailRes.rows[0].count, 10);
  const finalHist = parseInt(finalHistRes.rows[0].count, 10);

  console.log(`- Final rows in availability_view: ${finalAvail} (expected: ${initialAvail})`);
  console.log(`- Final rows in booking_history_view: ${finalHist} (expected: ${initialHist})`);

  if (finalAvail === initialAvail && finalHist === initialHist) {
    console.log('\nSUCCESS: Projection views reconstructed perfectly! Pre-truncate and post-truncate counts match.');
  } else {
    throw new Error(`REBUILD ERROR: Restored counts do not match original counts!`);
  }

  // Close database connection
  await pool.end();
  process.exit(0);
}

runDemo().catch(err => {
  console.error('Fatal error during projection rebuild demo:', err);
  pool.end().finally(() => process.exit(1));
});
