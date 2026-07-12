import http from 'http';
import dotenv from 'dotenv';
import { app } from './server.js';
import { startWebSocketGateway } from './wsGateway.js';
import { startAvailabilityProjection, flushAvailabilityProjection, stopAvailabilityProjection } from './projections/availabilityProjection.js';
import { startBookingHistoryProjection, flushBookingHistoryProjection, stopBookingHistoryProjection } from './projections/bookingHistoryProjection.js';
import { startBookingSaga, stopBookingSaga } from './saga/bookingSaga.js';
import { startExpirySweeper, stopExpirySweeper } from './saga/expirySweeper.js';
import { startOutboxRelay } from './outbox/outboxRelay.js';
import { pool } from './eventStore.js';

dotenv.config();

// Ensure Express listen hook doesn't start outbox relay by default, since we start it manually or let server.js start it.
process.env.DISABLE_OUTBOX_RELAY = 'true';

const PORT = process.env.PORT || 3000;

console.log('--- Starting Consolidated Render Server ---');

const server = http.createServer(app);

// 1. Start WebSocket Gateway on the shared HTTP server
try {
  startWebSocketGateway(server);
  console.log('[Component] WebSocket Gateway initialized on shared HTTP server.');
} catch (err) {
  console.error('[Component] Failed to start WebSocket Gateway:', err);
}

// 2. Start Availability Projection
try {
  startAvailabilityProjection({ startMetrics: false });
  console.log('[Component] Availability Projection consumer started.');
} catch (err) {
  console.error('[Component] Failed to start Availability Projection:', err);
}

// 3. Start Booking History Projection
try {
  startBookingHistoryProjection({ startMetrics: false });
  console.log('[Component] Booking History Projection consumer started.');
} catch (err) {
  console.error('[Component] Failed to start Booking History Projection:', err);
}

// 4. Start Booking Saga
try {
  startBookingSaga({ startMetrics: false });
  console.log('[Component] Booking Saga consumer started.');
} catch (err) {
  console.error('[Component] Failed to start Booking Saga:', err);
}

// 5. Start Expiry Sweeper
try {
  startExpirySweeper({ intervalMs: 30000 });
  console.log('[Component] Expiry Sweeper loop started.');
} catch (err) {
  console.error('[Component] Failed to start Expiry Sweeper:', err);
}

// 6. Start Transactional Outbox Relay
let activeRelay = null;
try {
  activeRelay = startOutboxRelay({ intervalMs: 500 });
  console.log('[Component] Transactional Outbox Relay started.');
} catch (err) {
  console.error('[Component] Failed to start Transactional Outbox Relay:', err);
}

// Start HTTP Server listening on process.env.PORT and 0.0.0.0
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[HTTP Server] Express App and WebSocket Gateway listening on port ${PORT} (0.0.0.0)`);
});

// Handle SIGTERM/SIGINT Gracefully
let isShuttingDown = false;
const shutdown = async () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('\n--- Graceful Shutdown Initiated ---');

  // Stop accepting new HTTP requests and websocket connections
  server.close(() => {
    console.log('[HTTP Server] Stopped listening for connections.');
  });

  // Stop background loops
  try {
    if (activeRelay) {
      activeRelay.stop();
    }
    stopExpirySweeper();
    console.log('[Component] Stopped outbox relay and expiry sweeper loops.');
  } catch (err) {
    console.error('Error stopping background loops:', err);
  }

  // Flush batched projections
  try {
    await Promise.all([
      flushAvailabilityProjection(),
      flushBookingHistoryProjection()
    ]);
    console.log('[Component] Flushed batched projection writes.');
  } catch (err) {
    console.error('Error flushing batches:', err);
  }

  // Stop Redis consumer connections
  try {
    await Promise.all([
      stopAvailabilityProjection(),
      stopBookingHistoryProjection(),
      stopBookingSaga()
    ]);
    console.log('[Component] Closed Redis connections.');
  } catch (err) {
    console.error('Error closing Redis connections:', err);
  }

  // Close database pool connection
  try {
    await pool.end();
    console.log('[Database] Database pool ended.');
  } catch (err) {
    console.error('Error closing database pool:', err);
  }

  console.log('--- Graceful Shutdown Complete. Exiting process. ---');
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
