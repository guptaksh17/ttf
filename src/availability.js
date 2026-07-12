import { pool } from './eventStore.js';
import { rebuildState } from './bookingAggregate.js';

/**
 * Checks if a requested booking range overlaps with any existing active bookings
 * for the same court and booking date.
 * 
 * NOTE ON O(n) IMPLEMENTATION:
 * This implementation is intentionally O(n) over the active booking streams for this
 * court/date. It queries the event_log, pulls all booking stream IDs, rebuilds their
 * state dynamically via rebuildState(), and performs overlap verification in-memory.
 * This guarantees correctness-first for Phase 2.
 * In Phase 3, this will be optimized to an indexed query against a denormalized projection.
 * 
 * @param {string} courtId - The UUID of the court
 * @param {string} bookingDate - The date in YYYY-MM-DD format
 * @param {number} startHour - The starting hour (24-hour integer format)
 * @param {number} durationHours - Duration of the slot in hours
 * @param {object} [db] - Optional pg client or pool to run queries inside a transaction
 * @returns {Promise<{hasOverlap: boolean, conflictingStreamIds: string[]}>}
 */
export async function hasOverlap(courtId, bookingDate, startHour, durationHours, db = pool) {
  const query = `
    SELECT DISTINCT stream_id
    FROM event_log
    WHERE event_type = 'SLOTS_RESERVED'
      AND payload->>'courtId' = $1
      AND payload->>'bookingDate' = $2
  `;

  const result = await db.query(query, [courtId, bookingDate]);
  const streamIds = result.rows.map(row => row.stream_id);

  const activeHoldStatuses = ['reserved', 'payment_pending', 'confirmed', 'booking_confirmed'];
  const conflictingStreamIds = [];

  const startA = parseInt(startHour, 10);
  const endA = startA + parseInt(durationHours, 10);

  for (const streamId of streamIds) {
    const state = await rebuildState(streamId, db);

    // Only active booking states can cause conflicts
    if (activeHoldStatuses.includes(state.status)) {
      const startB = parseInt(state.startHour, 10);
      const endB = startB + parseInt(state.durationHours, 10);

      // Overlap formula: startA < endB AND startB < endA
      if (startA < endB && startB < endA) {
        conflictingStreamIds.push(streamId);
      }
    }
  }

  return {
    hasOverlap: conflictingStreamIds.length > 0,
    conflictingStreamIds
  };
}
