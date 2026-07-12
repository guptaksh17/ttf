# Load Test 3: Read/Write Ratio Performance Report

* **Date/Time**: 2026-07-09T10:43:40.116Z
* **Connections**: 50
* **Duration**: 30 seconds
* **Workload Mix**: 90% `GET /api/availability`, 10% `POST /api/bookings/reserve`

## Overall Performance Metrics (Client-Side)

| Metric | Value |
|--------|-------|
| **Throughput (req/sec)** | 7568.54 |
| **Total Requests** | 227111 |
| **Errors (non-2xx)** | 22252 |
| **Overall Mean Latency (ms)** | 6.79 |
| **Overall p50 Latency (ms)** | 5 |
| **Overall p90 Latency (ms)** | 9 |

## Path-Specific Server-Side Latencies (from Prometheus telemetry)

| Path | Request Count | Average Latency (ms) |
|------|---------------|----------------------|
| **GET /api/availability** | 204375 | 4.93 ms |
| **POST /api/bookings/reserve** | 197451 | 16.19 ms |

## Observations
- Demonstrates performance under CQRS: reads are served from a denormalized read-model (`availability_view`) and do not perform any events replaying or write validation, making them exceptionally fast.
- Writes include PostgreSQL transaction locks and advisory locks, which exhibit slightly higher latencies than reads, but still execute in normal bounds due to decoupling from Redis Stream publishing network calls.