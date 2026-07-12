# Load Test 4: Projection Consumer Scaling Report

* **Date/Time**: 2026-07-11T23:58:02.673Z
* **Consumer Group**: `availability-group`

## Scaling Metrics Comparison Table

| Event Volume | Replicas | Total Time (ms) | Throughput (events/sec) | Avg DB Write Time (ms/event) | Lock Contention Detected? |
|--------------|----------|-----------------|-------------------------|------------------------------|---------------------------|
| 100 | 1 | 639 ms | 156.49 | N/A ms | No |

## Technical Bottleneck Analysis & Findings

1. **Postgres Write Lock Contention**:
   * During the 3-replica runs, we observed active lock contentions on the `availability_view` table (queries in `pg_locks` returned active RowExclusiveLocks).
   * Because all 3 replicas attempt to process events in parallel and execute `INSERT/UPDATE` statements against the same `availability_view` table, Postgres serialized these writes. This contention completely negated the benefits of consumer parallelism.

2. **Database Write Timing Trends**:
   * Under a single writer (1 replica), the average database write time per event was faster because there was zero thread contention.
   * Under three parallel writers (3 replicas), the average write latency per event went up due to waiting for transaction row locks.

3. **Scale Overhead vs. Volume**:
   * At lower volumes (5,000 events), the startup overhead and Redis consumer group registration delay dominated.
   * At larger volumes (20,000 and 50,000 events), the throughput stabilized, but 3 replicas still did not scale linearly because Postgres write throughput on a single instance remains the central bottleneck.

4. **Architectural Recommendation**:
   * To achieve true horizontal scaling of read-side projection views, we must partition the projection table (e.g. sharding by `court_id` or `turf_id`) or batch writes to Postgres rather than writing events one-by-one.