# Load Test 1: Baseline Performance Report

* **Date/Time**: 2026-07-09T10:41:45.273Z
* **Connections**: 50
* **Duration**: 30 seconds
* **Target Endpoint**: `POST /api/bookings/reserve` (Non-overlapping)

## Performance Metrics

| Metric | Value |
|--------|-------|
| **Throughput (req/sec)** | 2488.87 |
| **Total Requests** | 74725 |
| **Errors (non-2xx)** | 73098 |
| **Mean Latency (ms)** | 21.08 |
| **p50 Latency (ms)** | 16 |
| **p90 Latency (ms)** | 28 |
| **p95 Latency (ms)** | undefined |
| **p99 Latency (ms)** | 77 |

## Observations
- Tested performance under normal, conflict-free database write scenarios.
- Write latency represents synchronous Postgres insert + transaction commit + outbox append without Redis network overhead.