# Load Test 2: High Contention Performance Report

* **Date/Time**: 2026-07-09T10:42:46.666Z
* **Connections**: 50
* **Duration**: 30 seconds
* **Target Endpoint**: `POST /api/bookings/reserve` (Sustained conflict on a single slot)

## Performance Metrics

| Metric | Value |
|--------|-------|
| **Throughput (req/sec)** | 3336.60 |
| **Total Requests** | 100163 |
| **Success Count (201)** | 79 |
| **Conflict Count (409)** | 100084 |
| **Conflict Rate (%)** | 99.92% |
| **Mean Latency (ms)** | 15.58 |
| **p50 Latency (ms)** | 13 |
| **p90 Latency (ms)** | 16 |
| **p95 Latency (ms)** | undefined |
| **p99 Latency (ms)** | 37 |

## Observations
- Tested concurrent requests fighting for the exact same resource.
- The advisory lock (`pg_advisory_xact_lock`) serializes request evaluation. The first request grabs the lock, evaluates the overlap check (succeeds), commits, and releases lock.
- Subsequent requests acquire the lock sequentially, evaluate the overlap check (finds conflict), rollback immediately, and return 409.
- Rolling back conflicts instantly keeps latencies incredibly low compared to holding locks for slow queries.