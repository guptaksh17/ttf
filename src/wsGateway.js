import { WebSocketServer } from 'ws';
import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const PORT = process.env.WS_PORT || 3100; // Custom default port 3100, can configure via WS_PORT
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

let wss = null;
const clients = new Set();
let isRunning = false;

export function startWebSocketGateway(serverInstance = null) {
  if (isRunning) return;
  isRunning = true;

  if (serverInstance) {
    console.log('[WS-Gateway] Initializing WebSocket Server on shared HTTP instance.');
    wss = new WebSocketServer({ server: serverInstance });
  } else {
    console.log(`[WS-Gateway] WebSocket Server listening standalone on port ${PORT}`);
    wss = new WebSocketServer({ port: PORT });
  }

  wss.on('connection', (ws) => {
    console.log('[WS-Gateway] Client connected.');
    clients.add(ws);

    // Send initial connection status
    ws.send(JSON.stringify({ type: 'STATUS', message: 'Connected to TapToTurf Event Gateway' }));

    ws.on('close', () => {
      console.log('[WS-Gateway] Client disconnected.');
      clients.delete(ws);
    });
  });

  consumeEvents().catch((err) => {
    console.error('[WS-Gateway] Consumer fatal error:', err);
  });
}

// Configure ioredis client
const ignoreRedisStartup = process.env.IGNORE_REDIS_STARTUP_ERROR === 'true';
const redisOptions = {
  retryStrategy: (times) => {
    if (ignoreRedisStartup) {
      return Math.min(times * 500, 3000);
    }
    return null;
  },
  maxRetriesPerRequest: ignoreRedisStartup ? null : 1,
  enableOfflineQueue: ignoreRedisStartup ? false : true,
  connectTimeout: 2000
};

const redis = new Redis(REDIS_URL, redisOptions);
let isInitialConnect = true;

redis.on('connect', () => {
  isInitialConnect = false;
  console.log('[WS-Gateway] Redis connected successfully.');
});

redis.on('error', (err) => {
  if (isInitialConnect) {
    const host = redis.options.host || 'localhost';
    const port = redis.options.port || '6379';
    console.error(`[WS-Gateway] REDIS CONNECTION FAILED: ${err.message}, is Redis running on ${host}:${port}?`);
    if (ignoreRedisStartup) {
      console.warn('[WS-Gateway] Ignoring startup Redis error since IGNORE_REDIS_STARTUP_ERROR is true.');
      isInitialConnect = false;
    } else {
      process.exit(1);
    }
  }
});

// Redis Streams Consumer Group setup
const STREAM_NAME = 'taptoturf:events';
const GROUP_NAME = 'websocket-gateway-group';
const CONSUMER_NAME = `ws-gateway-consumer-${Math.random().toString(36).substring(2, 7)}`;

async function initConsumerGroup() {
  try {
    await redis.xgroup('CREATE', STREAM_NAME, GROUP_NAME, '$', 'MKSTREAM');
    console.log(`[WS-Gateway] Created consumer group ${GROUP_NAME}`);
  } catch (err) {
    if (!err.message.includes('BUSYGROUP')) {
      console.error('[WS-Gateway] Error creating consumer group:', err.message);
    }
  }
}

function broadcast(msg) {
  const payloadStr = JSON.stringify(msg);
  for (const client of clients) {
    if (client.readyState === 1) { // OPEN
      client.send(payloadStr);
    }
  }
}

async function consumeEvents() {
  await initConsumerGroup();

  console.log(`[WS-Gateway] Starting Redis Stream consumption loop...`);
  while (true) {
    try {
      // BLOCK 1000ms, COUNT 10, STREAMS taptoturf:events > (new messages)
      const result = await redis.xreadgroup(
        'GROUP', GROUP_NAME, CONSUMER_NAME,
        'BLOCK', '1000',
        'COUNT', '10',
        'STREAMS', STREAM_NAME, '>'
      );

      if (result) {
        for (const [, messages] of result) {
          for (const [messageId, fields] of messages) {
            const payloadIdx = fields.indexOf('payload');
            if (payloadIdx !== -1) {
              const eventStr = fields[payloadIdx + 1];
              const event = JSON.parse(eventStr);

              // Broadcast the parsed event as expected: { eventType, streamId, payload, timestamp }
              broadcast({
                type: 'EVENT',
                id: event.id,
                version: event.version,
                eventType: event.event_type,
                streamId: event.stream_id,
                payload: event.payload,
                timestamp: event.created_at || new Date().toISOString()
              });

              // Acknowledge event processed
              await redis.xack(STREAM_NAME, GROUP_NAME, messageId);
            }
          }
        }
      }
    } catch (err) {
      console.error('[WS-Gateway] Error in consumption loop:', err.message);
      // Wait to prevent tight loop during outages
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

// startWebSocketGateway must call consumeEvents
// We will edit the startWebSocketGateway definition to do this, and guard here
if (import.meta.url === `file://${process.argv[1]}`) {
  startWebSocketGateway();
}
