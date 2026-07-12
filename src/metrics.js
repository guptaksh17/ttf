import client from 'prom-client';
import http from 'http';

export const register = new client.Registry();

// Enable default metrics collection (e.g. CPU, memory)
client.collectDefaultMetrics({ register });

export const commandRequestsCounter = new client.Counter({
  name: 'command_requests_total',
  help: 'Total number of command requests',
  labelNames: ['endpoint', 'status_code'],
  registers: [register]
});

export const commandDurationHistogram = new client.Histogram({
  name: 'command_duration_seconds',
  help: 'Duration of command requests in seconds',
  labelNames: ['endpoint'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register]
});

export const eventsPublishedCounter = new client.Counter({
  name: 'events_published_total',
  help: 'Total number of events successfully published to Redis Stream',
  registers: [register]
});

export const outboxPendingGauge = new client.Gauge({
  name: 'outbox_pending_total',
  help: 'Current number of pending outbox events',
  registers: [register]
});

export const projectionLagHistogram = new client.Histogram({
  name: 'projection_lag_seconds',
  help: 'Projection processing lag in seconds',
  labelNames: ['projection_name'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register]
});

export const concurrencyConflictsCounter = new client.Counter({
  name: 'concurrency_conflicts_total',
  help: 'Total number of concurrency conflicts',
  labelNames: ['cause'],
  registers: [register]
});

export const projectionBatchSizeHistogram = new client.Histogram({
  name: 'projection_batch_size',
  help: 'Number of events included in each projection flush batch',
  labelNames: ['projection_name'],
  buckets: [1, 5, 10, 20, 30, 40, 50, 100],
  registers: [register]
});

export const projectionBatchWriteDurationHistogram = new client.Histogram({
  name: 'projection_batch_write_duration_seconds',
  help: 'Duration of batched database write queries in seconds',
  labelNames: ['projection_name'],
  buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register]
});

/**
 * Starts a standalone HTTP metrics server on the specified port.
 * Exposes GET /metrics endpoint for Prometheus scrapers.
 * 
 * @param {number} port - The port to listen on.
 * @returns {http.Server} The started http server instance.
 */
export function startMetricsServer(port) {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/metrics') {
      try {
        res.writeHead(200, { 'Content-Type': register.contentType });
        res.end(await register.metrics());
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(err.message);
      }
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  });

  server.listen(port, () => {
    console.log(`[Metrics] Standalone Prometheus metrics server listening on port ${port}`);
  });

  // Handle server errors to avoid crashing
  server.on('error', (err) => {
    console.error(`[Metrics] Error in standalone HTTP server on port ${port}:`, err);
  });

  return server;
}
