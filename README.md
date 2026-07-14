# TapToTurf

TapToTurf is an event-sourced, CQRS-based turf booking system built to demonstrate distributed systems correctness under real concurrency, failure, and scale conditions — not just a CRUD app with extra steps.

---

## Why This Project Exists

Most online booking systems are built as traditional CRUD applications with a single database table containing a `status` column and a timestamp. While simple, these designs fall apart under real-world concurrency, fail to provide auditing of how a state was reached, and lead to race conditions like double-booking when multiple users try to reserve the same slot.

TapToTurf treats every state change as an immutable, append-only event, separates reads from writes (CQRS), and implements robust concurrency controls. The system is designed to handle infrastructure failures (such as Redis connection drops, server crashes mid-transaction, and lock-holder container terminations) and guarantees correctness and durability under stress.

---


### Architectural Concepts Defined
* **Event Sourcing**: Replaces the traditional "current state" DB table. The system of record is an append-only log of events (`event_log`). The current state of any booking aggregate is dynamically derived by replaying these events sequentially.
* **CQRS (Command Query Responsibility Segregation)**: Separates the write model (validating business rules and appending events) from read models (serving queries). Read views are asynchronously populated from the event stream into optimized, denormalized Postgres tables.
* **Saga Pattern**: Orchestrates distributed transactions without two-phase commit. If a step in a multi-stage workflow fails (e.g. card payment fails after a slot hold is reserved), the Saga process manager listens to the failure event and triggers compensating events (`SLOTS_RELEASED`) to restore system consistency.
* **Transactional Outbox**: Guarantees at-least-once message delivery. Command handlers write events to `event_log` and `event_outbox` within the same ACID transaction. A background relay asynchronously reads from the outbox and publishes to Redis Streams, preventing event loss even if Redis crashes mid-flight.

---

## Core Guarantees

| Guarantee | How it's enforced | Verified by |
|---|---|---|
| **No double-bookings under concurrency** | PostgreSQL advisory locks scoped to `(court_id, booking_date)` serialize checks. | 0 double-bookings across 60+ concurrent requests across 3 independent runs. |
| **State is always derivable** | `rebuildState()` replays `event_log`; no direct `UPDATE` statement ever mutates booking status. | `demoFullRebuild.js`: dynamic read model teardown and full reconstruction from 66,000+ events with exact count match. |
| **Automatic recovery from payment failure** | Saga listens for `PAYMENT_FAILED` and appends compensating `SLOTS_RELEASED` event; idempotent under duplicate delivery. | Integration test `testPhase4_paymentFailedSaga.js` simulating duplicate deliveries. |
| **Abandoned reservations release slots** | Time-based background expiry sweeper running on a scheduler. Race-safe against concurrent late payment confirmations. | Expiry sweeper integration test `testPhase4_expirySweep.js`. |
| **No event loss during Redis outages** | Transactional Outbox pattern commits events and outbox rows atomically. Relay retries publishing until Redis is reachable. | Chaos test `chaosTest2b_redisOutageWithOutbox.js`. Writes succeed during Redis outage and auto-publish when Redis is restored. |
| **Read models can be rebuilt with zero data loss** | Projections are pure functions of the event log. `rebuildProjection.js` replays full log history to reconstruct views. | `demoFullRebuild.js` count verification. |
| **Advisory locks never deadlock on crash** | PostgreSQL session-level advisory locks release automatically on connection termination. | Chaos test `chaosTest4_lockHolderKilled.js` demonstrating lock release in **~50ms** after container termination. |

---

## Performance & Scalability Benchmarks

### 1. Replay Snapshotting Speedup
Replaying a stream's entire history from scratch becomes slow as streams grow. We implement periodic snapshotting (saving state every 5 events) in `bookingAggregate.js` and benchmarked replay speedups:

| Event Count | Full Replay Time | Snapshot Replay Time | Speedup Factor |
|-------------|------------------|----------------------|----------------|
| **100** | ~11 ms | ~10 ms | ~1.1x |
| **1,000** | ~110 ms | ~10 ms | ~11x |
| **10,000** | ~1.1 s | ~45 ms | ~24x |
| **50,000** | ~5.8 s | ~45 ms | ~130x |

*Note: At low event counts (e.g. 100), the overhead of querying the snapshot table negates speedups. However, at higher event counts, snapshotting scales to a **130x speedup** by avoiding full replay.*

### 2. HTTP API Load Testing (autocannon)
Captured using 50 concurrent connections over 30 seconds:
* **Baseline Writes (`POST /api/bookings/reserve` - Non-overlapping)**: **2,488.87 requests/sec** (Mean Latency: **21.08 ms**).
* **High Contention (`POST /api/bookings/reserve` - Single-slot contention)**: **3,336.60 requests/sec** (Mean Latency: **15.58 ms**). Lock serialization handles concurrent conflicts with minimal overhead by failing fast and rolling back immediately.
* **Mixed Workload (90% Reads / 10% Writes)**: **7,568.54 requests/sec** overall client throughput. Server-side metrics showed **4.93 ms** avg read latency vs **16.19 ms** avg write latency.

### 3. Projection Consumer Scaling & Write Batching Optimization
We ran dedicated scaling benchmarks at 5,000 and 50,000 event volumes under both unbatched (Phase 8) and batched (Phase 9) write configurations:

#### Unbatched Scaling Results (Phase 8)
* **1 Replica (50k events)**: **1,502.63 events/sec** (Avg DB write: **0.35 ms/event**)
* **3 Replicas (50k events)**: **1,107.79 events/sec** (Avg DB write: **0.51 ms/event**)
* *Bottleneck*: Parallel unbatched updates compete for transaction locks, generating active `RowExclusiveLock` entries on the shared table and degrading throughput.

#### Batched Scaling Results (Phase 9 - Batch Size: 50, Timeout: 100ms)
* **1 Replica (50k events)**: **1,152.10 events/sec** (Avg Batch write: **2.61 ms**)
* **3 Replicas (50k events)**: **1,145.03 events/sec** (Avg Batch write: **2.94 ms**)
* *Analysis & Findings*: 
  * Enabling write batching improved the 3-replica throughput modestly from **1,107.79 events/sec** (unbatched) to **1,145.03 events/sec** (batched).
  * However, batching made the 1-replica throughput worse (from **1,502.63 events/sec** unbatched down to **1,152.10 events/sec** batched) due to timer/buffering latency check overhead.
  * Ultimately, 3 replicas still do not clearly outperform 1 replica even after batching. Database-level serialization on a single unpartitioned table (`availability_view`) remains the primary bottleneck. True linear horizontal scaling would require table partitioning (e.g. sharding by court) or DB-layer write buffers.


---

## Infrastructure Chaos Engineering

We utilize Docker Compose to simulate infrastructure failures at the operating-system level:

1. **Chaos Test 1 (Kill Mid-Transaction)**: Kill the `command-api` container mid-flight during a reservation write. Verified PostgreSQL either completely rolls back or fully commits the write; state is never corrupted.
2. **Chaos Test 2 (Redis Outage & Recovery)**: Fired commands when Redis was stopped. The Command API successfully completed Postgres commits locally. Once Redis was started, the outbox relay automatically published all missed events, recovering the read-path with **zero manual intervention**.
3. **Chaos Test 3 (Kill Projection Consumer)**: Killed projection consumer, wrote new events, and restarted it. The consumer group resumed from the correct offset and caught up in **336.82 ms** without processing duplicate events.
4. **Chaos Test 4 (Lock Holder Killed)**: Killed the container holding an active Postgres transaction advisory lock. Postgres freed the session-level lock automatically in **50.45 ms**, preventing deadlocks.

---

## Tech Stack

### Backend
* **Runtime**: Node.js (ES Modules)
* **API Framework**: Express
* **Database**: PostgreSQL (No ORM. Precise transaction boundaries, isolation levels, and advisory locks are controlled via raw SQL to ensure correctness)
* **Event Bus**: Redis Streams (using `ioredis` consumer groups)
* **Containerization**: Docker & Docker Compose
* **Instrumentation**: Prometheus (`prom-client`)
* **Load Testing**: Autocannon

### Frontend
* **Core**: React 18, Vite (for asset bundling & hot-reloading)
* **Styling**: Tailwind CSS
* **Animations**: Framer Motion
* **Visual Data**: Recharts (for live-updating metrics/charts in the admin panel)
* **Auth**: JSON Web Tokens (`jsonwebtoken`) + client role-checking + `bcrypt` password hashing
* **Sync**: WebSockets (`ws` / client native `WebSocket`) for real-time availability updates

---

## Project Structure

```text
├── benchmarks/           # Performance, snapshotting, and chaos test reports
├── chaos-tests/          # Docker-based fault injection scripts (kill containers, verify recovery)
├── load-tests/           # Autocannon scripts & JSON results for load benchmarks
├── migrations/           # Database migration files (001_create_reference_tables to 007_add_auth)
├── src/
│   ├── outbox/           # Transactional outbox relay background daemon
│   ├── projections/      # Read-model projection consumers (availability and history views)
│   ├── saga/             # Payment-failed and expiry-sweeper saga processes
│   ├── availability.js   # Court slot overlap checker logic
│   ├── bookingAggregate.js # Dynamic aggregate state rebuilder and snapshotter
│   ├── eventPublisher.js # Raw Redis Streams publisher configuration
│   ├── eventStore.js     # postgres pool setup, appendEvent, and getEventStream
│   ├── metrics.js        # prom-client metrics setup & Prometheus scrape HTTP server
│   ├── server.js         # Command Express HTTP API
│   ├── wsGateway.js      # WebSocket Event Broadcast Server
│   └── renderMain.js     # Consolidated Render server entry point
├── frontend/             # React SPA Frontend codebase
│   ├── public/           # Public assets and _redirects routing rule
│   └── src/              # React source code (components, pages, context, hooks)
├── docker-compose.chaos.yml # Chaos testing services stack
├── docker-compose.metrics.yml # Prometheus telemetry stack
├── render.yaml           # Render deployment blueprint file
└── package.json
```

---

## Frontend Application & Auth Roles

TapToTurf features a rich, responsive frontend SPA featuring four primary views:

1. **Booking Dashboard**: Displays live court availability grids. Supports booking slots with a dynamic duration hours selector (automatically highlights consecutive slots, recalculates prices, and performs atomic PG-level checkouts).
2. **Booking History**: Allows users to review all past, current, and pending reservations. Provides one-click cancellation.
3. **Admin Panel**:
   - *Dashboard*: Live-updating metrics showcasing total revenue, booking counts, payment success/failure rates, and conflict counters.
   - *Manage Panel*: CRUD controls to add, edit, or delete turfs and courts (blocks turf/court deletion if active booking history exists).
4. **Event Log Viewer**: Exposes the raw, append-only `event_log` system of record.
   - *Collapsible payload inspectors*: Drill down into raw JSON payload changes.
   - *Interactive stream playback visualizer*: Collapses history and steps through aggregate state transitions version-by-version.
   - *User scoping*: Admins view all events with usernames; regular users see only their own event stream.

### Authentication & Authorization System
* **Auth**: JSON Web Tokens (`jsonwebtoken`) issued securely at `/api/auth/login`. Password storage hashed using `bcrypt`.
* **Admin Experience Isolation**: Admin accounts (`admin@gmail.com`) are restricted strictly to admin routes (`/admin` and `/admin/manage`) and the shared `/events` log, while regular users have exclusive access to booking (`/`) and history (`/history`).
* **Route Protection**: Implements Client-Side React Route guards and server-side JWT authentication verification.

---

## Consolidated Render Server (`src/renderMain.js`)

For $0-tier deployments on hosting platforms like Render, we consolidate the entire backend architecture into a single Node process:
* Serves the Express Command API and the WebSocket Gateway on the **same shared port** on the same HTTP/WS server instance.
* Runs the transactional outbox relay, background projection consumers, and periodic expiry sweepers in-process as concurrent background fibers.
* Shuts down gracefully, flushing batched memory writes and cleanly terminating active Redis groups on SIGTERM.

---

## Running It Locally

### Prerequisites
* Node.js v20+
* PostgreSQL running locally on port 5432 (database: `taptoturf_dev`)
* Redis running locally on port 6379

### Setup & Run Backend
1. Install root dependencies:
   ```bash
   npm install
   ```
2. Configure environment variables in `.env`:
   ```env
   DATABASE_URL=postgresql://<username>:<password>@localhost:5432/<database_name>
   REDIS_URL=redis://localhost:6379
   IGNORE_REDIS_STARTUP_ERROR=false
   JWT_SECRET=taptoturf_secret
   ```
3. Initialize the database and run migrations:
   ```bash
   npm run db:migrate
   ```
4. Seed reference data:
   ```bash
   npm run db:seed
   ```
5. Start the consolidated backend:
   ```bash
   node src/renderMain.js
   ```

### Setup & Run Frontend
1. Navigate to `/frontend` and install dependencies:
   ```bash
   cd frontend
   npm install
   ```
2. Start the Vite dev server:
   ```bash
   npm run dev
   ```
3. Open browser at [http://localhost:5173](http://localhost:5173).

---

## Next Steps & Improvements

1. **Partition Projection Writes**: Address the remaining single-table serialization bottleneck observed in Phase 9 by sharding or partitioning the `availability_view` database table by `court_id`.
2. **Consolidated Docker Orchestration**: Combine the chaos testing compose stack and metrics monitoring stack into a single docker-compose setup suitable for staging deployment.
3. **Outbox Cleanup Daemon**: Add a background cleanup task to prune successfully published records from `event_outbox` periodically to prevent table bloating.

