import { pool } from '../eventStore.js';
import { publishEvent } from '../eventPublisher.js';
import { eventsPublishedCounter, outboxPendingGauge, startMetricsServer } from '../metrics.js';

let isRunning = false;

/**
 * Executes a single relay cycle.
 * Retrieves up to 50 unpublished events, publishes them to Redis Stream,
 * and updates their status in Postgres upon successful delivery.
 */
export async function runRelayCycle() {
  if (isRunning) return;
  isRunning = true;

  let processedFullBatch = false;
  try {
    // 1. Retrieve unpublished events from outbox JOIN event_log
    const query = `
      SELECT o.id AS outbox_id, l.id, l.stream_id, l.version, l.event_type, l.payload, l.metadata, l.created_at
      FROM event_outbox o
      JOIN event_log l ON o.event_log_id = l.id
      WHERE o.published = false
      ORDER BY o.id ASC
      LIMIT 50;
    `;
    const res = await pool.query(query);

    if (res.rows.length === 0) {
      isRunning = false;
      return;
    }

    if (res.rows.length === 50) {
      processedFullBatch = true;
    }

    console.log(`[OutboxRelay] Found ${res.rows.length} unpublished events. Processing...`);

    for (const row of res.rows) {
      // Map back to event structure format expected by publishEvent
      const event = {
        id: row.id,
        stream_id: row.stream_id,
        version: parseInt(row.version, 10),
        event_type: row.event_type,
        payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
        metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
        created_at: row.created_at
      };

      try {
        // 2. Publish to Redis Stream
        await publishEvent(event, true);

        // 3. Mark as published in Postgres
        await pool.query(
          'UPDATE event_outbox SET published = true, published_at = now() WHERE id = $1',
          [row.outbox_id]
        );
        eventsPublishedCounter.inc();
        console.log(`[OutboxRelay] Successfully published event ${event.event_type} (${event.stream_id})`);
      } catch (err) {
        // Log the failure and break processing loop.
        // The event remains unpublished and will be retried in the next cycle.
        console.error(`[OutboxRelay] Failed to publish event ${row.event_type} (${row.stream_id}). Error: ${err.message}`);
        console.log(`[OutboxRelay] Redis is likely unreachable. Event will be retried in the next poll cycle.`);
        processedFullBatch = false;
        break; 
      }
    }
  } catch (err) {
    console.error('[OutboxRelay] Error in relay cycle:', err.message);
  } finally {
    try {
      const pendingRes = await pool.query('SELECT COUNT(*) FROM event_outbox WHERE published = false');
      const count = parseInt(pendingRes.rows[0].count, 10);
      outboxPendingGauge.set(count);
    } catch (gaugeErr) {
      console.error('[OutboxRelay] Error updating outbox pending gauge:', gaugeErr.message);
    }
    isRunning = false;
  }

  if (processedFullBatch) {
    setImmediate(runRelayCycle);
  }
}

/**
 * Starts the background polling interval.
 * Returns a handle object with a stop() method to clear the timer.
 */
export function startRelay(intervalMs = 500) {
  console.log(`[OutboxRelay] Starting background relay polling loop (interval: ${intervalMs}ms)...`);
  const intervalId = setInterval(runRelayCycle, intervalMs);

  // Run immediately on start
  runRelayCycle();

  return {
    stop() {
      console.log('[OutboxRelay] Stopping outbox relay polling loop.');
      clearInterval(intervalId);
    }
  };
}

export function startOutboxRelay(options = {}) {
  const { intervalMs = 500 } = options;
  return startRelay(intervalMs);
}

// Support direct standalone execution
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('[OutboxRelay] Running in standalone process mode.');

  const metricsServer = startMetricsServer(3004);
  const relay = startOutboxRelay();

  const shutdown = async () => {
    console.log('[OutboxRelay] Shutting down...');
    relay.stop();
    try {
      if (metricsServer) {
        metricsServer.close();
      }
      await pool.end();
    } catch (e) {
      console.error(e);
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
