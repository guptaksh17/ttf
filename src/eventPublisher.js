import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const redisOptions = {
  retryStrategy: (times) => {
    if (process.env.IGNORE_REDIS_STARTUP_ERROR === 'true') {
      return Math.min(times * 500, 3000);
    }
    return null;
  },
  maxRetriesPerRequest: process.env.IGNORE_REDIS_STARTUP_ERROR === 'true' ? null : 1,
  enableOfflineQueue: process.env.IGNORE_REDIS_STARTUP_ERROR === 'true' ? false : true,
  connectTimeout: 2000
};

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
export const redis = new Redis(redisUrl, redisOptions);

let isInitialConnect = true;
redis.on('connect', () => {
  isInitialConnect = false;
  console.log('Redis connected successfully.');
});

redis.on('error', (err) => {
  if (isInitialConnect) {
    const host = redis.options.host || 'localhost';
    const port = redis.options.port || '6379';
    console.error(`REDIS CONNECTION FAILED: ${err.message}, is Redis running on ${host}:${port}?`);
    if (process.env.IGNORE_REDIS_STARTUP_ERROR === 'true') {
      console.warn('[eventPublisher] Ignoring startup Redis error since IGNORE_REDIS_STARTUP_ERROR is true.');
      // Turn off isInitialConnect so we don't spam exit attempts
      isInitialConnect = false;
    } else {
      process.exit(1);
    }
  }
});

/**
 * Publishes an event to the Redis Stream.
 * 
 * DESIGN RATIONALE:
 * This publish must happen AFTER the Postgres transaction commits, not before.
 * If the publish fails (e.g. Redis is offline), we log the error clearly but do NOT
 * throw or fail the HTTP response. The event is already durably stored in the Postgres event_log
 * (our source of truth). The Redis Stream is a secondary distribution mechanism for building
 * read-model projections and running real-time tasks asynchronously.
 * 
 * @param {object} event - The database event row containing id, stream_id, version, event_type, payload, metadata, created_at.
 * @returns {Promise<void>}
 */
export async function publishEvent(event, throwOnError = false) {
  try {
    // Publish using XADD. The event is stringified to preserve full structure.
    await redis.xadd('taptoturf:events', '*', 'payload', JSON.stringify(event));
  } catch (error) {
    console.error('EVENT PUBLISHING ERROR: Failed to publish event to Redis Streams.', {
      streamId: event.stream_id,
      eventType: event.event_type,
      version: event.version,
      error: error.message
    });
    if (throwOnError) {
      throw error;
    }
  }
}
