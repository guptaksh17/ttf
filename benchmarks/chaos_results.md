# TapToTurf Phase 6 Chaos Testing Results

This document summarizes the outcomes, metrics, architectural gaps, and mitigation strategies observed during our controlled chaos testing phase against containerized command API and projection nodes.

---

## Chaos Test 1: Kill Command API Mid-Transaction
* **Target broken**: `command-api` Docker container killed mid-flight (`docker kill`) during transaction processing.
* **Mechanism**: Added `TEST_ARTIFICIAL_DELAY_MS` delay window of 3000ms inside `POST /api/bookings/reserve` post-lock, pre-commit.
* **Expected behavior**: Postgres database guarantees atomicity (ACID). The transaction must either fully commit or fully rollback; no partial or corrupt state may exist in the event log.
* **Actual behavior**:
  - Direct database query confirmed **0 rows** written (successful transaction rollback).
  - The severed TCP socket was terminated immediately.
  - On restart, the command server successfully handled a new request on the same slot with a **201 Created** status code, confirming the advisory lock was released.
* **Recovery path**: Automatic. The Postgres database engine rolls back uncommitted transactions when client connections die.

---

## Chaos Test 2: Redis Outage During Active Booking Flow
* **Target broken**: Local host Redis instance stopped (`brew services stop redis`) immediately prior to writing to the database command path.
* **Expected behavior**: The command server must successfully handle write validations, commit the transaction to PostgreSQL (our source of truth), and return a **201 Created** success response to the client. Secondary projection update failures must not compromise the write transaction.
* **Actual behavior**:
  - The HTTP request successfully returned **201 Created**.
  - PostgreSQL committed the event log row correctly.
  - The projection view (`availability_view`) did **not** sync the booking, remaining empty.
  - After Redis was restarted, the booking remained missing (proving the event was lost in transit because event publishing failed when Redis was offline).
* **Gaps found**: **Durable event delivery gap**. If Redis is down when the event is committed to Postgres, the `publishEvent` function fails to write to the Redis Stream. The projection views will permanently miss this event until reconciled.
* **Mitigation path**: Rebuilding read views. Running `node src/projections/rebuildProjection.js availability` reads chronologically from the Postgres event log source of truth, reconstructing all read views successfully and bringing them back in sync. In production, we would mitigate this using the *Durable Outbox Pattern* (reading Postgres WAL or using an outbox table) instead of a fire-and-forget publish.

---

## Chaos Test 3: Kill Projection Consumer Mid-Stream
* **Target broken**: `availability-projection` Docker container killed mid-flight (`docker kill`) while handling active streams.
* **Expected behavior**: Events sitting unconsumed in the Redis stream must remain intact. When the container restarts, it must resume consumption exactly from its last acknowledged offset using Redis Streams consumer group mechanics.
* **Actual behavior**:
  - Fired 3 baseline reservations (successfully projected).
  - Killed consumer, fired 3 more reservations (stuck in stream).
  - Restarted consumer. It successfully processed the pending events and caught up in **336.82ms**.
  - Integrity check verified exactly 6 reservations with 0 skipped and 0 duplicate events.
* **Recovery path**: Automatic. Redis Streams consumer group pending queues (`XREADGROUP` / `XACK`) track delivery offsets durably.

---

## Chaos Test 4: Advisory Lock Holder Connection Terminated
* **Target broken**: `command-api` container killed while holding active transaction-level advisory locks.
* **Expected behavior**: Postgres must automatically release session-level advisory locks when the holding connection dies, preventing permanent deadlocks for concurrent requests.
* **Actual behavior**:
  - First request acquired lock and slept. Container killed.
  - Fallback local node started on host and immediately fired a duplicate reservation request for the same slot.
  - Latency check confirmed the lock was released in **50.45ms** (Postgres automatically cleaned up the session lock when the TCP socket closed).
  - The second request successfully acquired the lock and completed with a **201 Created** status.
* **Recovery path**: Automatic. PostgreSQL auto-releases session locks upon client disconnect.

---

## Chaos Test 2b: Redis Outage With Transactional Outbox Recovery
* **Target broken**: Local host Redis instance stopped (`brew services stop redis`) during decoupled write command and projection consumer execution.
* **Mechanism**: Transactional Outbox Pattern with `event_outbox` table and outbox relay.
* **Expected behavior**: The command server must handle reservations with normal latencies, committing events and queuing them in the outbox atomically. While Redis is down, the outbox relay must log failures and retries. When Redis starts up again, the relay must automatically publish pending events, updating projection views without developer/manual intervention.
* **Actual behavior**:
  - The HTTP request successfully returned **201 Created** with a decoupled API latency of **83.77ms** (normal write latency).
  - PostgreSQL committed the event to `event_log` and registered an unpublished outbox queue row (`published = false`) atomically.
  - The `command-api` outbox relay logged failed publishing attempts.
  - After Redis was restored, the outbox relay automatically published the event and updated status to `published = true` in Postgres.
  - Projections caught up automatically and the booking appeared in `availability_view`.
* **Resolution**: The **Durable event delivery gap** from Chaos Test 2 is completely resolved with zero manual intervention required.

