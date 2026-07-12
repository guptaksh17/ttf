import Redis from 'ioredis';
import dotenv from 'dotenv';
import { pool, appendEvent, ConcurrencyError } from '../eventStore.js';
import { rebuildState } from '../bookingAggregate.js';
import { publishEvent } from '../eventPublisher.js';
import { startMetricsServer } from '../metrics.js';

dotenv.config();

const groupName = 'booking-saga-group';
const consumerName = `booking-saga-consumer-${process.pid}`;
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
  console.log('Redis connected successfully in booking saga.');
});

redis.on('error', (err) => {
  if (isInitialConnect) {
    const host = redis.options.host || 'localhost';
    const port = redis.options.port || '6379';
    console.error(`REDIS CONNECTION FAILED in booking saga: ${err.message}, is Redis running on ${host}:${port}?`);
    if (process.env.IGNORE_REDIS_STARTUP_ERROR === 'true') {
      console.warn('[bookingSaga] Ignoring startup Redis error since IGNORE_REDIS_STARTUP_ERROR is true.');
      isInitialConnect = false;
    } else {
      process.exit(1);
    }
  }
});

/**
 * Shared event processing logic for the booking saga.
 * Triggers compensating commands for payment failures.
 */
export async function processSagaEvent(event) {
  const { event_type, stream_id } = event;

  if (event_type === 'PAYMENT_FAILED') {
    console.log(`Saga received PAYMENT_FAILED for stream ${stream_id}. Processing compensation...`);

    // Rebuild aggregate state fresh to confirm write eligibility
    const state = await rebuildState(stream_id);
    if (state.status === 'payment_failed') {
      try {
        console.log(`Compensating stream ${stream_id}: Appending SLOTS_RELEASED event at expectedVersion=${state.version}`);
        // Append event (runs as part of auto-committed/independent insert)
        const compEvent = await appendEvent(stream_id, state.version, 'SLOTS_RELEASED', {});
        
        // Publish compensating event to Redis Stream
        await publishEvent(compEvent);
        console.log(`Compensation event SLOTS_RELEASED appended and published for stream ${stream_id}.`);
      } catch (error) {
        if (error instanceof ConcurrencyError) {
          console.log(`Compensation already applied for stream ${stream_id}, skipping.`);
        } else {
          throw error;
        }
      }
    } else {
      console.log(`Stream ${stream_id} status is already '${state.status}'. Skipping compensation.`);
    }
  }
}

async function startSaga() {
  console.log(`Starting Booking Saga Consumer: Group=${groupName}, Consumer=${consumerName}`);

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

  // Live block read loop
  while (true) {
    try {
      // BLOCK 1000ms, COUNT 10, STREAMS taptoturf:events > (new messages)
      const result = await redis.xreadgroup(
        'GROUP', groupName, consumerName,
        'BLOCK', '1000',
        'COUNT', '10',
        'STREAMS', streamName, '>'
      );

      if (result) {
        for (const [, messages] of result) {
          for (const [messageId, fields] of messages) {
            const payloadIdx = fields.indexOf('payload');
            if (payloadIdx !== -1) {
              const eventStr = fields[payloadIdx + 1];
              const event = JSON.parse(eventStr);

              await processSagaEvent(event);
            }

            // Always acknowledge message after attempt (including skipped types and exceptions caught inside handlers)
            await redis.xack(streamName, groupName, messageId);
          }
        }
      }
    } catch (err) {
      console.error('Error processing booking saga stream message:', err);
      // Wait to prevent tight CPU loop during Redis or DB transient errors
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

export async function startBookingSaga(options = {}) {
  const { startMetrics = false } = options;
  let metricsServer;
  if (startMetrics) {
    const metricsPort = parseInt(process.env.METRICS_PORT || '3013', 10);
    try {
      metricsServer = startMetricsServer(metricsPort);
    } catch (e) {
      console.warn('Could not start booking saga metrics server:', e.message);
    }
  }

  // Handle SIGINT/SIGTERM if started standalone
  if (startMetrics) {
    const shutdown = async () => {
      console.log('Shutting down booking saga...');
      try {
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

  await startSaga();
}

export async function stopBookingSaga() {
  await redis.quit();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startBookingSaga({ startMetrics: true }).catch(err => {
    console.error('Fatal error in booking saga process:', err);
    process.exit(1);
  });
}
