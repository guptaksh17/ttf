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
  console.log('--- Starting Load Test 1: Baseline Performance ---');
  
  // 1. Truncate tables for a clean baseline test state
  console.log('Truncating tables for clean state...');
  await pool.query('TRUNCATE event_log, event_outbox, availability_view, booking_history_view CASCADE');
  await pool.end();

  // 2. Pre-generate non-overlapping slots to avoid conflicts
  console.log('Pre-generating unique non-overlapping reservation requests...');
  const requests = [];
  const courtIds = [
    '12bbc9f4-0b6a-4fb6-b668-81025e84dfe8', // Court 1
    '540afd19-fd78-4e28-93ff-2c83b38a2638', // Net A
    '5dcb68b8-167c-476e-a4b8-f1ae1f3c5f44'  // Court B
  ];
  const userId = '3c8a9807-6b45-4df6-a67b-bf08e001550c';
  const token = jwt.sign({ id: userId, role: 'user' }, process.env.JWT_SECRET || 'taptoturf_secret', { expiresIn: '1d' });
  
  // Generate ~50,000 non-overlapping slots
  let count = 0;
  const targetCount = 50000;
  for (let dayOffset = 0; dayOffset < 3000 && count < targetCount; dayOffset++) {
    const date = new Date(Date.now() + dayOffset * 24 * 60 * 60 * 1000);
    const dateString = date.toISOString().split('T')[0];
    
    for (const courtId of courtIds) {
      for (let startHour = 8; startHour < 20; startHour += 2) {
        requests.push({
          method: 'POST',
          path: '/api/bookings/reserve',
          headers: { 
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({
            courtId,
            bookingDate: dateString,
            startHour,
            durationHours: 2
          })
        });
        count++;
        if (count >= targetCount) break;
      }
      if (count >= targetCount) break;
    }
  }

  console.log(`Generated ${requests.length} unique reservation requests.`);

  // 3. Configure Autocannon
  const options = {
    url: 'http://localhost:3000',
    connections: 50,
    duration: 30,
    requests
  };

  console.log('Running load test (50 connections, 30 seconds)...');
  const result = await autocannon(options);
  console.log('Load test completed.');

  // 4. Save results
  const resultsDir = path.join(__dirname, 'results');
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }

  const jsonPath = path.join(resultsDir, 'loadTest1_baseline.json');
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));
  console.log(`JSON results saved to: ${jsonPath}`);

  // 5. Generate Markdown Report
  const mdReport = `
# Load Test 1: Baseline Performance Report

* **Date/Time**: ${new Date().toISOString()}
* **Connections**: 50
* **Duration**: 30 seconds
* **Target Endpoint**: \`POST /api/bookings/reserve\` (Non-overlapping)

## Performance Metrics

| Metric | Value |
|--------|-------|
| **Throughput (req/sec)** | ${result.requests.average.toFixed(2)} |
| **Total Requests** | ${result.requests.sent} |
| **Errors (non-2xx)** | ${result.non2xx} |
| **Mean Latency (ms)** | ${result.latency.average.toFixed(2)} |
| **p50 Latency (ms)** | ${result.latency.p50} |
| **p90 Latency (ms)** | ${result.latency.p90} |
| **p95 Latency (ms)** | ${result.latency.p95} |
| **p99 Latency (ms)** | ${result.latency.p99} |

## Observations
- Tested performance under normal, conflict-free database write scenarios.
- Write latency represents synchronous Postgres insert + transaction commit + outbox append without Redis network overhead.
  `;

  const mdPath = path.join(resultsDir, 'loadTest1_baseline.md');
  fs.writeFileSync(mdPath, mdReport.trim());
  console.log(`Markdown report saved to: ${mdPath}`);
}

run().catch(err => {
  console.error('Error running baseline load test:', err);
  process.exit(1);
});
