import { pool, getAllEvents } from '../eventStore.js';
import { handleAvailabilityEvent, redis as availRedis } from './availabilityProjection.js';
import { handleBookingHistoryEvent, redis as histRedis } from './bookingHistoryProjection.js';

/**
 * Replays all events in the event store to rebuild both read-model projections.
 * Used by the Admin Dashboard rebuild programmatical route.
 * 
 * @param {pg.Client} client - The Postgres transaction client
 * @param {function} onProgress - Callback function(current, total) for progress reporting
 * @returns {Promise<number>} - Count of events processed
 */
export async function rebuildBothProjections(client, onProgress) {
  console.log('[Rebuild] Truncating availability_view and booking_history_view...');
  await client.query('TRUNCATE TABLE availability_view, booking_history_view CASCADE;');

  console.log('[Rebuild] Fetching all immutable events from log...');
  const events = await getAllEvents(client);
  const total = events.length;
  console.log(`[Rebuild] Replaying ${total} events through both projection handlers...`);

  let count = 0;
  if (total === 0) {
    if (onProgress) onProgress(0, 0);
    return 0;
  }

  for (const event of events) {
    await handleAvailabilityEvent(event, client);
    await handleBookingHistoryEvent(event, client);
    count++;

    if (onProgress && (count % 10 === 0 || count === total)) {
      onProgress(count, total);
    }
  }

  console.log(`[Rebuild] Rebuild complete. Processed ${count} events.`);
  return count;
}

// CLI Script execution runner
const isMain = process.argv[1] && (
  process.argv[1].endsWith('rebuildProjection.js') ||
  process.argv[1].endsWith('projections/rebuildProjection.js')
);

if (isMain) {
  const projectionName = process.argv[2];
  if (projectionName !== 'availability' && projectionName !== 'booking-history' && projectionName !== 'both') {
    console.error('Invalid argument. Usage: node src/projections/rebuildProjection.js [availability|booking-history|both]');
    process.exit(1);
  }

  console.log(`Starting rebuild of: ${projectionName}`);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    if (projectionName === 'both') {
      await rebuildBothProjections(client, (current, total) => {
        console.log(`Progress: Replayed ${current}/${total} events...`);
      });
    } else if (projectionName === 'availability') {
      console.log('Truncating availability_view...');
      await client.query('TRUNCATE TABLE availability_view CASCADE;');
      const events = await getAllEvents(client);
      let count = 0;
      for (const event of events) {
        await handleAvailabilityEvent(event, client);
        count++;
        if (count % 100 === 0) console.log(`Processed ${count}/${events.length}...`);
      }
      console.log(`REBUILD SUCCESSFUL: availability_view rebuilt with ${count} events.`);
    } else {
      console.log('Truncating booking_history_view...');
      await client.query('TRUNCATE TABLE booking_history_view CASCADE;');
      const events = await getAllEvents(client);
      let count = 0;
      for (const event of events) {
        await handleBookingHistoryEvent(event, client);
        count++;
        if (count % 100 === 0) console.log(`Processed ${count}/${events.length}...`);
      }
      console.log(`REBUILD SUCCESSFUL: booking_history_view rebuilt with ${count} events.`);
    }

    await client.query('COMMIT');
    console.log('Rebuild completed successfully.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`Rebuild failed for ${projectionName}:`, error);
    process.exit(1);
  } finally {
    client.release();
    await availRedis.quit();
    await histRedis.quit();
    await pool.end();
  }
}
