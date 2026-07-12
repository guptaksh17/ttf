import pg from 'pg';
import dotenv from 'dotenv';
import { concurrencyConflictsCounter } from './metrics.js';

dotenv.config();

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

export class ConcurrencyError extends Error {
  constructor(streamId, version, originalError) {
    super(`Concurrency conflict: stream_id ${streamId} already has version ${version}`);
    this.name = 'ConcurrencyError';
    this.streamId = streamId;
    this.version = version;
    this.originalError = originalError;
  }
}

/**
 * Appends an event to the event store.
 * Increments the version to expectedVersion + 1.
 * Throws a ConcurrencyError if a unique violation (23505) occurs on (stream_id, version).
 */
export async function appendEvent(streamId, expectedVersion, eventType, payload, metadata = {}, db = pool) {
  const nextVersion = expectedVersion + 1;
  const query = `
    INSERT INTO event_log (stream_id, version, event_type, payload, metadata)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id, stream_id, version, event_type, payload, metadata, created_at
  `;

  try {
    const result = await db.query(query, [
      streamId,
      nextVersion,
      eventType,
      payload,
      metadata
    ]);
    const eventRow = result.rows[0];

    // Atomically record in outbox table within the same transaction
    await db.query(`
      INSERT INTO event_outbox (event_log_id, published)
      VALUES ($1, false)
    `, [eventRow.id]);

    return eventRow;
  } catch (error) {
    // 23505 is the Postgres code for unique_violation
    if (error.code === '23505') {
      concurrencyConflictsCounter.inc({ cause: 'version_conflict' });
      throw new ConcurrencyError(streamId, nextVersion, error);
    }
    throw error;
  }
}

/**
 * Retrieves all events for a given streamId, ordered by version ascending.
 */
export async function getEventStream(streamId, db = pool) {
  const query = `
    SELECT id, stream_id, version, event_type, payload, metadata, created_at
    FROM event_log
    WHERE stream_id = $1
    ORDER BY version ASC
  `;
  const result = await db.query(query, [streamId]);
  return result.rows;
}

/**
 * Retrieves all events across all streams, ordered by created_at ascending.
 */
export async function getAllEvents(db = pool) {
  const query = `
    SELECT id, stream_id, version, event_type, payload, metadata, created_at
    FROM event_log
    ORDER BY created_at ASC
  `;
  const result = await db.query(query);
  return result.rows;
}
