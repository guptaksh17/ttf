import { pool, appendEvent, ConcurrencyError } from '../eventStore.js';
import { rebuildState } from '../bookingAggregate.js';
import { publishEvent, redis } from '../eventPublisher.js';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Runs a single cycle of the expiry sweep.
 * Safely handles transaction-level advisory locks to ensure serializability with payment confirmations.
 */
export async function runSweep() {
  console.log('Expiry sweep: starting cycle...');

  let expiredReservations = [];
  try {
    const res = await pool.query(`
      SELECT stream_id, court_id, booking_date::text as booking_date
      FROM availability_view
      WHERE status = 'reserved' AND reservation_expires_at < NOW();
    `);
    expiredReservations = res.rows;
  } catch (err) {
    console.error('Error querying expired reservations from availability_view:', err);
    return;
  }

  const checkedCount = expiredReservations.length;
  let releasedCount = 0;

  for (const reservation of expiredReservations) {
    const { stream_id: streamId, court_id: courtId, booking_date: bookingDate } = reservation;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Acquire advisory lock to serialize check with concurrent write-paths
      const lockKey = `${courtId}_${bookingDate}`;
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey]);

      // Rebuild the aggregate state fresh INSIDE the lock boundary
      const state = await rebuildState(streamId, client);

      if (state.status === 'reserved') {
        console.log(`Sweeper: stream ${streamId} is expired and still 'reserved'. Appending SLOTS_RELEASED...`);
        const event = await appendEvent(streamId, state.version, 'SLOTS_RELEASED', {}, {}, client);
        
        await client.query('COMMIT');

        // Publish event to Redis Stream after transaction commits
        await publishEvent(event);
        releasedCount++;
      } else {
        console.log(`Sweeper: stream ${streamId} status was advanced to '${state.status}' concurrently. Skipping release.`);
        await client.query('ROLLBACK');
      }

    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('Failed to rollback transaction in sweeper:', rollbackErr);
      }

      if (err instanceof ConcurrencyError) {
        console.log(`Sweeper: Concurrency conflict for stream ${streamId}, skipping.`);
      } else {
        console.error(`Sweeper: Error processing stream ${streamId}:`, err);
      }
    } finally {
      client.release();
    }
  }

  console.log(`Expiry sweep: checked ${checkedCount} reservations, expired and released ${releasedCount}.`);
}

let intervalId = null;

export async function startExpirySweeper(options = {}) {
  const { intervalMs = 30000 } = options;
  const isStandalone = import.meta.url === `file://${process.argv[1]}`;

  if (isStandalone && process.argv.includes('--run-once')) {
    console.log('Sweeper running in single-sweep mode (--run-once)...');
    try {
      await runSweep();
    } catch (err) {
      console.error('Fatal error in sweeper single run:', err);
      process.exit(1);
    }
    try {
      await redis.quit();
      await pool.end();
    } catch (e) {
      console.error('Error closing sweeper resources:', e);
    }
    process.exit(0);
  } else {
    console.log(`Sweeper running in polling mode (every ${intervalMs}ms)...`);
    runSweep().catch(err => console.error('Error in initial sweep:', err));
    intervalId = setInterval(() => {
      runSweep().catch(err => console.error('Error in sweep cycle:', err));
    }, intervalMs);
  }

  // Handle SIGINT/SIGTERM if started standalone
  if (isStandalone && !process.argv.includes('--run-once')) {
    const shutdown = async () => {
      console.log('Shutting down expiry sweeper...');
      try {
        if (intervalId) {
          clearInterval(intervalId);
        }
        await redis.quit();
        await pool.end();
      } catch (e) {
        console.error('Error during sweeper shutdown cleanups:', e);
      }
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}

export function stopExpirySweeper() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startExpirySweeper().catch(err => {
    console.error('Fatal error in sweeper process:', err);
    process.exit(1);
  });
}
