import { pool } from './src/eventStore.js';
import { rebuildState, rebuildStateWithSnapshot, applyEvent, initialState } from './src/bookingAggregate.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EVENT_TYPES = [
  'PAYMENT_INITIATED',
  'PAYMENT_CONFIRMED',
  'BOOKING_CONFIRMED',
  'PAYMENT_INITIATED',
  'PAYMENT_CONFIRMED'
];

/**
 * Inserts events in chunks to bypass PG parameter limit (65535)
 */
async function bulkInsertEvents(events) {
  const chunkSize = 2000;
  for (let i = 0; i < events.length; i += chunkSize) {
    const chunk = events.slice(i, i + chunkSize);
    const valueStrings = [];
    const values = [];

    chunk.forEach((event, idx) => {
      const baseIdx = idx * 5;
      valueStrings.push(`($${baseIdx + 1}, $${baseIdx + 2}, $${baseIdx + 3}, $${baseIdx + 4}, $${baseIdx + 5})`);
      values.push(
        event.stream_id,
        event.version,
        event.event_type,
        JSON.stringify(event.payload),
        JSON.stringify(event.metadata)
      );
    });

    const query = `
      INSERT INTO event_log (stream_id, version, event_type, payload, metadata)
      VALUES ${valueStrings.join(', ')}
    `;
    await pool.query(query, values);
  }
}

/**
 * Inserts snapshots in chunks
 */
async function bulkInsertSnapshots(snapshots) {
  const chunkSize = 2000;
  for (let i = 0; i < snapshots.length; i += chunkSize) {
    const chunk = snapshots.slice(i, i + chunkSize);
    const valueStrings = [];
    const values = [];

    chunk.forEach((snap, idx) => {
      const baseIdx = idx * 3;
      valueStrings.push(`($${baseIdx + 1}, $${baseIdx + 2}, $${baseIdx + 3})`);
      values.push(
        snap.stream_id,
        snap.version,
        JSON.stringify(snap.state)
      );
    });

    const query = `
      INSERT INTO aggregate_snapshots (stream_id, version, state)
      VALUES ${valueStrings.join(', ')}
      ON CONFLICT (stream_id, version) DO NOTHING
    `;
    await pool.query(query, values);
  }
}

async function runBenchmark() {
  console.log('=== TapToTurf Phase 5: Replay Performance Benchmark ===\n');

  const streamLengths = [100, 1000, 5000, 10000, 50000];
  const results = [];

  for (const len of streamLengths) {
    console.log(`Generating synthetic event stream of length ${len}...`);
    const streamId = crypto.randomUUID();
    const events = [];
    const snapshots = [];
    let state = { ...initialState };

    for (let v = 1; v <= len; v++) {
      let eventType = '';
      let payload = {};

      if (v === 1) {
        eventType = 'SLOTS_RESERVED';
        payload = {
          courtId: crypto.randomUUID(),
          userId: crypto.randomUUID(),
          bookingDate: '2026-07-08',
          startHour: 10,
          durationHours: 1,
          totalAmount: 100,
          reservationExpiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString()
        };
      } else {
        eventType = EVENT_TYPES[(v - 2) % EVENT_TYPES.length];
      }

      const event = {
        stream_id: streamId,
        version: v,
        event_type: eventType,
        payload,
        metadata: {}
      };

      events.push(event);
      state = applyEvent(state, event);

      // Snapshot every 5 versions
      if (v % 5 === 0) {
        snapshots.push({
          stream_id: streamId,
          version: v,
          state
        });
      }
    }

    console.log(`Inserting ${events.length} events into database...`);
    await bulkInsertEvents(events);

    console.log(`Inserting ${snapshots.length} snapshots into database...`);
    if (snapshots.length > 0) {
      await bulkInsertSnapshots(snapshots);
    }

    // We will run the benchmarks 5 times for each stream length.
    // Discard the first run, and calculate the median of the remaining 4.
    const fullRuns = [];
    const snapRuns = [];

    // Run 0 (Warmup)
    console.log(`[Warmup] Benchmarking full replay for length ${len}...`);
    await rebuildState(streamId);
    console.log(`[Warmup] Benchmarking snapshot-aware replay for length ${len}...`);
    await rebuildStateWithSnapshot(streamId);

    // Runs 1 to 5
    for (let run = 1; run <= 5; run++) {
      // Benchmark Full Replay
      const fullStart = performance.now();
      await rebuildState(streamId);
      const fullTime = performance.now() - fullStart;
      fullRuns.push(fullTime);

      // Benchmark Snapshot Replay
      const snapStart = performance.now();
      await rebuildStateWithSnapshot(streamId);
      const snapTime = performance.now() - snapStart;
      snapRuns.push(snapTime);
    }

    // Discard the first run of the 5 runs (warmup/JIT)
    const activeFullRuns = fullRuns.slice(1);
    const activeSnapRuns = snapRuns.slice(1);

    const getMedian = (arr) => {
      const sorted = [...arr].sort((a, b) => a - b);
      const mid = sorted.length / 2;
      return sorted.length % 2 !== 0 ? sorted[Math.floor(mid)] : (sorted[mid - 1] + sorted[mid]) / 2;
    };

    const medianFull = getMedian(activeFullRuns);
    const medianSnap = getMedian(activeSnapRuns);
    const speedup = (medianFull / medianSnap).toFixed(1);

    console.log(`Results for ${len} events (median of 4 active runs):`);
    console.log(`- Full Replay: ${medianFull.toFixed(2)}ms`);
    console.log(`- Snapshot Replay: ${medianSnap.toFixed(2)}ms`);
    console.log(`- Speedup: ${speedup}x\n`);

    results.push({
      events: len,
      fullTime: parseFloat(medianFull.toFixed(2)),
      snapTime: parseFloat(medianSnap.toFixed(2)),
      speedup: `${speedup}x`
    });
  }

  // Create comparison table markdown
  let markdown = `# Snapshotting Replay Benchmarks\n\n`;
  markdown += `Generated on: ${new Date().toISOString()}\n\n`;
  markdown += `| Events | Full Replay (ms) | Snapshot Replay (ms) | Speedup |\n`;
  markdown += `|--------|------------------|----------------------|---------|\n`;

  results.forEach(res => {
    markdown += `| ${res.events.toString().padEnd(6)} | ${res.fullTime.toString().padEnd(16)} | ${res.snapTime.toString().padEnd(20)} | ${res.speedup.padEnd(7)} |\n`;
  });

  console.log('Benchmark Results Table:');
  console.log(markdown);

  // Write markdown to benchmarks/snapshot_results.md
  const benchmarksDir = path.join(__dirname, 'benchmarks');
  if (!fs.existsSync(benchmarksDir)) {
    fs.mkdirSync(benchmarksDir);
  }
  fs.writeFileSync(path.join(benchmarksDir, 'snapshot_results.md'), markdown, 'utf-8');
  console.log(`Saved benchmark results to ${path.join(benchmarksDir, 'snapshot_results.md')}`);

  // Exit cleanly
  await pool.end();
  process.exit(0);
}

runBenchmark().catch(err => {
  console.error('Fatal error in benchmark script:', err);
  pool.end().finally(() => process.exit(1));
});
