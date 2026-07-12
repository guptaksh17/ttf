import Redis from 'ioredis';
import dotenv from 'dotenv';
import { performance } from 'perf_hooks';
import { pool } from '../eventStore.js';
import { 
  projectionLagHistogram, 
  startMetricsServer, 
  projectionBatchSizeHistogram, 
  projectionBatchWriteDurationHistogram 
} from '../metrics.js';

dotenv.config();

const groupName = 'booking-history-group';
const consumerName = `booking-history-consumer-${process.pid}`;
const streamName = 'taptoturf:events';

const redisOptions = {
  retryStrategy: (times) => {
    if (process.env.IGNORE_REDIS_STARTUP_ERROR === 'true') {
      return Math.min(times * 500, 3000);
    }
    return null;
  },
  maxRetriesPerRequest: process.env.IGNORE_REDIS_STARTUP_ERROR === 'true' ? null : 1,
  connectTimeout: 2000
};

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
export const redis = new Redis(redisUrl, redisOptions);

let isInitialConnect = true;
redis.on('connect', () => {
  isInitialConnect = false;
  console.log('Redis connected successfully in booking history consumer.');
});

redis.on('error', (err) => {
  if (isInitialConnect) {
    const host = redis.options.host || 'localhost';
    const port = redis.options.port || '6379';
    console.error(`REDIS CONNECTION FAILED in booking history consumer: ${err.message}, is Redis running on ${host}:${port}?`);
    if (process.env.IGNORE_REDIS_STARTUP_ERROR === 'true') {
      console.warn('[bookingHistoryProjection] Ignoring startup Redis error since IGNORE_REDIS_STARTUP_ERROR is true.');
      isInitialConnect = false;
    } else {
      process.exit(1);
    }
  }
});

/**
 * Shared event handler logic for maintaining the booking history view read model.
 * Made available for both live consumer execution and replay/rebuild scripts.
 */
export async function handleBookingHistoryEvent(event, db = pool) {
  const { event_type, stream_id, payload } = event;

  if (event_type === 'SLOTS_RESERVED') {
    const query = `
      INSERT INTO booking_history_view (stream_id, user_id, court_id, booking_date, start_hour, duration_hours, total_amount, status, last_updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      ON CONFLICT (stream_id) DO UPDATE
      SET status = EXCLUDED.status, last_updated_at = NOW();
    `;
    await db.query(query, [
      stream_id,
      payload.userId,
      payload.courtId,
      payload.bookingDate,
      payload.startHour,
      payload.durationHours,
      payload.totalAmount,
      'reserved'
    ]);
  } else {
    // Map of aggregate status transitions based on event types
    const statusMap = {
      PAYMENT_INITIATED: 'payment_pending',
      PAYMENT_CONFIRMED: 'confirmed',
      BOOKING_CONFIRMED: 'booking_confirmed',
      PAYMENT_FAILED: 'payment_failed',
      SLOTS_RELEASED: 'released',
      BOOKING_CANCELLED: 'cancelled'
    };

    const targetStatus = statusMap[event_type];
    if (targetStatus) {
      const query = `
        UPDATE booking_history_view
        SET status = $1, last_updated_at = NOW()
        WHERE stream_id = $2
          AND (
            status IS NULL
            OR status = $1
            OR CASE status
                 WHEN 'reserved' THEN 0
                 WHEN 'payment_pending' THEN 1
                 WHEN 'confirmed' THEN 2
                 WHEN 'booking_confirmed' THEN 3
                 WHEN 'released' THEN 4
                 WHEN 'cancelled' THEN 4
                 ELSE -1
               END < CASE $1::text
                 WHEN 'reserved' THEN 0
                 WHEN 'payment_pending' THEN 1
                 WHEN 'confirmed' THEN 2
                 WHEN 'booking_confirmed' THEN 3
                 WHEN 'released' THEN 4
                 WHEN 'cancelled' THEN 4
                 ELSE -1
               END
          );
      `;
      await db.query(query, [targetStatus, stream_id]);
    }
  }
}

/**
  * Batched event handler for booking history view.
  * Groups multiple inserts and updates into unified statements.
  */
export async function handleBookingHistoryEventsBatched(events, db = pool) {
  const rawInsertEvents = events.filter(e => e.event_type === 'SLOTS_RESERVED');
  const rawUpdateEvents = events.filter(e => e.event_type !== 'SLOTS_RESERVED');

  // Deduplicate inserts keeping the latest one in the batch
  const uniqueInsertsMap = new Map();
  for (const e of rawInsertEvents) {
    uniqueInsertsMap.set(e.stream_id, e);
  }
  const insertEvents = Array.from(uniqueInsertsMap.values());

  // Deduplicate updates keeping the latest one in the batch
  const uniqueUpdatesMap = new Map();
  for (const e of rawUpdateEvents) {
    uniqueUpdatesMap.set(e.stream_id, e);
  }
  const updateEvents = Array.from(uniqueUpdatesMap.values());

  if (insertEvents.length > 0) {
    let queryText = 'INSERT INTO booking_history_view (stream_id, user_id, court_id, booking_date, start_hour, duration_hours, total_amount, status, last_updated_at) VALUES ';
    const params = [];
    let paramIndex = 1;

    for (let i = 0; i < insertEvents.length; i++) {
      const { stream_id, payload } = insertEvents[i];
      if (i > 0) queryText += ', ';
      queryText += `($${paramIndex}, $${paramIndex+1}, $${paramIndex+2}, $${paramIndex+3}, $${paramIndex+4}, $${paramIndex+5}, $${paramIndex+6}, $${paramIndex+7}, NOW())`;
      params.push(
        stream_id,
        payload.userId,
        payload.courtId,
        payload.bookingDate,
        payload.startHour,
        payload.durationHours,
        payload.totalAmount,
        'reserved'
      );
      paramIndex += 8;
    }

    queryText += ' ON CONFLICT (stream_id) DO UPDATE SET status = EXCLUDED.status, last_updated_at = NOW()';
    await db.query(queryText, params);
  }

  if (updateEvents.length > 0) {
    const statusMap = {
      PAYMENT_INITIATED: 'payment_pending',
      PAYMENT_CONFIRMED: 'confirmed',
      BOOKING_CONFIRMED: 'booking_confirmed',
      PAYMENT_FAILED: 'payment_failed',
      SLOTS_RELEASED: 'released',
      BOOKING_CANCELLED: 'cancelled'
    };

    let queryText = 'UPDATE booking_history_view AS h SET status = tmp.status, last_updated_at = NOW() FROM (VALUES ';
    const params = [];
    let paramIndex = 1;
    let validUpdatesCount = 0;

    for (let i = 0; i < updateEvents.length; i++) {
      const { stream_id, event_type } = updateEvents[i];
      const targetStatus = statusMap[event_type];
      if (targetStatus) {
        if (validUpdatesCount > 0) queryText += ', ';
        queryText += `($${paramIndex}::uuid, $${paramIndex+1}::text)`;
        params.push(stream_id, targetStatus);
        paramIndex += 2;
        validUpdatesCount++;
      }
    }

    queryText += `
      ) AS tmp(stream_id, status)
      WHERE h.stream_id = tmp.stream_id
        AND (
          h.status IS NULL
          OR h.status = tmp.status
          OR CASE h.status
               WHEN 'reserved' THEN 0
               WHEN 'payment_pending' THEN 1
               WHEN 'confirmed' THEN 2
               WHEN 'booking_confirmed' THEN 3
               WHEN 'released' THEN 4
               WHEN 'cancelled' THEN 4
               ELSE -1
             END < CASE tmp.status
               WHEN 'reserved' THEN 0
               WHEN 'payment_pending' THEN 1
               WHEN 'confirmed' THEN 2
               WHEN 'booking_confirmed' THEN 3
               WHEN 'released' THEN 4
               WHEN 'cancelled' THEN 4
               ELSE -1
             END
        )
    `;

    if (validUpdatesCount > 0) {
      await db.query(queryText, params);
    }
  }
}

/**
 * BatchProcessor accumulates event updates in-memory and flushes them 
 * based on size threshold or timeout to optimize Postgres lock acquisition.
 */
export class BatchProcessor {
  constructor(projectionName, flushFn) {
    this.projectionName = projectionName;
    this.flushFn = flushFn;
    this.buffer = [];
    this.batchSize = parseInt(process.env.PROJECTION_BATCH_SIZE || '50', 10);
    this.batchTimeoutMs = parseInt(process.env.PROJECTION_BATCH_TIMEOUT_MS || '100', 10);
    this.timeoutId = null;
    this.flushPromise = Promise.resolve();
  }

  async add(event, messageId) {
    this.buffer.push({ event, messageId });
    if (this.buffer.length >= this.batchSize) {
      await this.flush();
    } else {
      this.resetTimeout();
    }
  }

  resetTimeout() {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
    }
    this.timeoutId = setTimeout(() => {
      this.flush().catch(err => {
        console.error(`[BatchProcessor:${this.projectionName}] Timeout flush failed:`, err);
      });
    }, this.batchTimeoutMs);
  }

  async flush() {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }

    if (this.buffer.length === 0) return;

    const currentBatch = this.buffer;
    this.buffer = [];

    this.flushPromise = this.flushPromise.then(async () => {
      const startTime = performance.now();
      try {
        await this.flushFn(currentBatch.map(b => b.event));
        
        // Acknowledge all message IDs in the batch
        await Promise.all(currentBatch.map(b => redis.xack(streamName, groupName, b.messageId)));

        const durationSeconds = (performance.now() - startTime) / 1000;
        projectionBatchSizeHistogram.observe({ projection_name: this.projectionName }, currentBatch.length);
        projectionBatchWriteDurationHistogram.observe({ projection_name: this.projectionName }, durationSeconds);

        // Record lag metrics
        for (const { event } of currentBatch) {
          const lagSeconds = (Date.now() - new Date(event.created_at).getTime()) / 1000;
          projectionLagHistogram.observe({ projection_name: this.projectionName }, lagSeconds);
        }
      } catch (err) {
        console.error(`[BatchProcessor:${this.projectionName}] Flush failed. Crashing to force stream redelivery:`, err);
        process.exit(1);
      }
    });

    await this.flushPromise;
  }
}

export let batchProcessor = null;

async function startConsumer() {
  console.log(`Starting Booking History Projection Consumer: Group=${groupName}, Consumer=${consumerName}`);

  let totalEventsProcessed = 0;
  let totalDbTimeMs = 0;
  let totalIdleTimeMs = 0;

  // Create stream and consumer group if they do not exist
  try {
    await redis.xgroup('CREATE', streamName, groupName, '0', 'MKSTREAM');
    console.log(`Created consumer group "${groupName}".`);
  } catch (err) {
    if (err.message.includes('BUSYGROUP')) {
      console.log(`Consumer group "${groupName}" already exists.`);
    } else {
      throw err;
    }
  }

  // Register shutdown logging summary
  let totalFlushes = 0;
  const logSummary = () => {
    if (totalEventsProcessed > 0) {
      console.log(`[Metrics-Summary] Consumer ${consumerName} processed ${totalEventsProcessed} events.`);
      console.log(`[Metrics-Summary] Total DB write time: ${totalDbTimeMs.toFixed(2)}ms.`);
      console.log(`[Metrics-Summary] Total flushes: ${totalFlushes}.`);
      console.log(`[Metrics-Summary] Avg batch write duration: ${totalFlushes > 0 ? (totalDbTimeMs / totalFlushes).toFixed(3) : 0}ms.`);
      console.log(`[Metrics-Summary] Avg batch size: ${totalFlushes > 0 ? (totalEventsProcessed / totalFlushes).toFixed(1) : 0} events.`);
      console.log(`[Metrics-Summary] Total idle (blocking read) time: ${totalIdleTimeMs.toFixed(2)}ms.`);
    }
  };
  process.on('SIGINT', logSummary);
  process.on('SIGTERM', logSummary);

  // Initialize batch processor
  batchProcessor = new BatchProcessor('booking_history', async (events) => {
    const dbStart = performance.now();
    await handleBookingHistoryEventsBatched(events);
    totalDbTimeMs += (performance.now() - dbStart);
    totalEventsProcessed += events.length;
    totalFlushes++;

    if (totalEventsProcessed % 1000 < events.length) {
      console.log(`[Metrics-Summary] Processed ${totalEventsProcessed} events. Current DB avg: ${(totalDbTimeMs / totalEventsProcessed).toFixed(3)}ms/event.`);
      console.log(`[Metrics-Summary] Current flushes: ${totalFlushes}.`);
      console.log(`[Metrics-Summary] Current avg batch write duration: ${totalFlushes > 0 ? (totalDbTimeMs / totalFlushes).toFixed(3) : 0}ms.`);
      console.log(`[Metrics-Summary] Current avg batch size: ${totalFlushes > 0 ? (totalEventsProcessed / totalFlushes).toFixed(1) : 0} events.`);
    }
  });

  const disableBatching = process.env.PROJECTION_DISABLE_BATCHING === 'true';
  if (disableBatching) {
    console.log('[bookingHistoryProjection] Write batching is disabled (running in fallback single-event mode).');
  } else {
    console.log(`[bookingHistoryProjection] Write batching is enabled (size: ${batchProcessor.batchSize}, timeout: ${batchProcessor.batchTimeoutMs}ms).`);
  }

  // Live block read loop
  while (true) {
    try {
      const readStart = performance.now();
      // BLOCK 1000ms, COUNT 10, STREAMS taptoturf:events > (new messages)
      const result = await redis.xreadgroup(
        'GROUP', groupName, consumerName,
        'BLOCK', '1000',
        'COUNT', '10',
        'STREAMS', streamName, '>'
      );
      const readDuration = performance.now() - readStart;

      if (!result) {
        totalIdleTimeMs += readDuration;
      }

      if (result) {
        for (const [, messages] of result) {
          for (const [messageId, fields] of messages) {
            const payloadIdx = fields.indexOf('payload');
            if (payloadIdx !== -1) {
              const eventStr = fields[payloadIdx + 1];
              const event = JSON.parse(eventStr);

              if (disableBatching) {
                // Fallback / Single-event mode
                const dbStart = performance.now();
                await handleBookingHistoryEvent(event);
                totalDbTimeMs += (performance.now() - dbStart);
                totalEventsProcessed++;

                const lagSeconds = (Date.now() - new Date(event.created_at).getTime()) / 1000;
                projectionLagHistogram.observe({ projection_name: 'booking_history' }, lagSeconds);

                await redis.xack(streamName, groupName, messageId);

                if (totalEventsProcessed % 1000 === 0) {
                  console.log(`[Metrics-Summary] Processed ${totalEventsProcessed} events. Current DB avg: ${(totalDbTimeMs / totalEventsProcessed).toFixed(3)}ms/event.`);
                }
              } else {
                // Batched mode
                await batchProcessor.add(event, messageId);
              }
            }
          }
        }
      }
    } catch (err) {
      console.error('Error processing booking history projection stream message:', err);
      // Wait to prevent tight CPU looping during Redis or DB transient errors
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

export async function startBookingHistoryProjection(options = {}) {
  const { startMetrics = false } = options;
  let metricsServer;
  if (startMetrics) {
    const metricsPort = parseInt(process.env.METRICS_PORT || '3012', 10);
    try {
      metricsServer = startMetricsServer(metricsPort);
    } catch (e) {
      console.warn('Could not start booking history metrics server:', e.message);
    }
  }

  // Handle SIGINT/SIGTERM if started standalone
  if (startMetrics) {
    const shutdown = async () => {
      console.log('Shutting down booking history consumer...');
      try {
        if (batchProcessor) {
          console.log('Flushing outstanding buffered batches...');
          await batchProcessor.flush();
        }
        if (metricsServer) {
          metricsServer.close();
        }
        await redis.quit();
        await pool.end();
      } catch (e) {
        console.error('Error during shutdown cleanups:', e);
      }
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }

  await startConsumer();
}

export async function flushBookingHistoryProjection() {
  if (batchProcessor) {
    console.log('Flushing booking history projection batch...');
    await batchProcessor.flush();
  }
}

export async function stopBookingHistoryProjection() {
  await flushBookingHistoryProjection();
  await redis.quit();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startBookingHistoryProjection({ startMetrics: true }).catch(err => {
    console.error('Fatal error in booking history consumer process:', err);
    process.exit(1);
  });
}
