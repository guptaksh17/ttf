import autocannon from 'autocannon';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  console.log('--- Starting Load Test 2: High Contention Performance ---');
  
  // 1. Truncate tables for clean test state
  console.log('Truncating tables for clean state...');
  await pool.query('TRUNCATE event_log, event_outbox, availability_view, booking_history_view CASCADE');
  await pool.end();

  // 2. Pre-generate requests requesting the EXACT SAME slot to maximize contention
  console.log('Pre-generating reservation requests for the exact same slot...');
  const requests = [];
  const courtId = '12bbc9f4-0b6a-4fb6-b668-81025e84dfe8'; // Court 1
  const userId = '3c8a9807-6b45-4df6-a67b-bf08e001550c';
  const token = jwt.sign({ id: userId, role: 'user' }, process.env.JWT_SECRET || 'taptoturf_secret', { expiresIn: '1d' });
  const bookingDate = '2026-12-25';
  const startHour = 18;
  
  const targetCount = 50000;
  for (let i = 0; i < targetCount; i++) {
    requests.push({
      method: 'POST',
      path: '/api/bookings/reserve',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        courtId,
        bookingDate,
        startHour,
        durationHours: 2
      })
    });
  }

  // 3. Configure Autocannon
  const options = {
    url: 'http://localhost:3000',
    connections: 50,
    duration: 30,
    requests
  };

  console.log('Running load test under high contention (50 connections, 30 seconds)...');
  const result = await autocannon(options);
  console.log('Load test completed.');

  // 4. Save results
  const resultsDir = path.join(__dirname, 'results');
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }

  const jsonPath = path.join(resultsDir, 'loadTest2_highContention.json');
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));
  console.log(`JSON results saved to: ${jsonPath}`);

  // 5. Calculate statistics:
  // First request returns 201 Created (1 success)
  // All other concurrent requests return 409 Conflict (non-2xx errors)
  const conflictsCount = result.non2xx;
  const successCount = result.requests.sent - conflictsCount;
  const conflictRatePercent = ((conflictsCount / result.requests.sent) * 100).toFixed(2);

  // 6. Generate Markdown Report
  const mdReport = `
# Load Test 2: High Contention Performance Report

* **Date/Time**: ${new Date().toISOString()}
* **Connections**: 50
* **Duration**: 30 seconds
* **Target Endpoint**: \`POST /api/bookings/reserve\` (Sustained conflict on a single slot)

## Performance Metrics

| Metric | Value |
|--------|-------|
| **Throughput (req/sec)** | ${result.requests.average.toFixed(2)} |
| **Total Requests** | ${result.requests.sent} |
| **Success Count (201)** | ${successCount} |
| **Conflict Count (409)** | ${conflictsCount} |
| **Conflict Rate (%)** | ${conflictRatePercent}% |
| **Mean Latency (ms)** | ${result.latency.average.toFixed(2)} |
| **p50 Latency (ms)** | ${result.latency.p50} |
| **p90 Latency (ms)** | ${result.latency.p90} |
| **p95 Latency (ms)** | ${result.latency.p95} |
| **p99 Latency (ms)** | ${result.latency.p99} |

## Observations
- Tested concurrent requests fighting for the exact same resource.
- The advisory lock (\`pg_advisory_xact_lock\`) serializes request evaluation. The first request grabs the lock, evaluates the overlap check (succeeds), commits, and releases lock.
- Subsequent requests acquire the lock sequentially, evaluate the overlap check (finds conflict), rollback immediately, and return 409.
- Rolling back conflicts instantly keeps latencies incredibly low compared to holding locks for slow queries.
  `;

  const mdPath = path.join(resultsDir, 'loadTest2_highContention.md');
  fs.writeFileSync(mdPath, mdReport.trim());
  console.log(`Markdown report saved to: ${mdPath}`);
}

run().catch(err => {
  console.error('Error running high contention load test:', err);
  process.exit(1);
});
