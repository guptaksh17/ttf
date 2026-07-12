import { getEventStream, pool } from './eventStore.js';

export const EVENTS = {
  SLOTS_RESERVED: 'SLOTS_RESERVED',
  PAYMENT_INITIATED: 'PAYMENT_INITIATED',
  PAYMENT_CONFIRMED: 'PAYMENT_CONFIRMED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  SLOTS_RELEASED: 'SLOTS_RELEASED',
  BOOKING_CONFIRMED: 'BOOKING_CONFIRMED',
  BOOKING_CANCELLED: 'BOOKING_CANCELLED'
};

export const initialState = {
  status: 'none',
  courtId: null,
  userId: null,
  bookingDate: null,
  startHour: null,
  durationHours: 0,
  totalAmount: 0,
  version: 0
};

/**
 * Pure reducer function that applies an event to a given state.
 * Returns the new state object.
 */
export function applyEvent(currentState, event) {
  // Create a shallow copy of current state to ensure pure function characteristics
  const nextState = { ...currentState };
  const payload = event.payload || {};

  switch (event.event_type) {
    case EVENTS.SLOTS_RESERVED:
      nextState.status = 'reserved';
      nextState.courtId = payload.courtId;
      nextState.userId = payload.userId;
      nextState.bookingDate = payload.bookingDate;
      nextState.startHour = payload.startHour;
      nextState.durationHours = payload.durationHours;
      nextState.totalAmount = parseFloat(payload.totalAmount);
      break;
    case EVENTS.PAYMENT_INITIATED:
      nextState.status = 'payment_pending';
      break;
    case EVENTS.PAYMENT_CONFIRMED:
      nextState.status = 'confirmed';
      break;
    case EVENTS.PAYMENT_FAILED:
      nextState.status = 'payment_failed';
      break;
    case EVENTS.SLOTS_RELEASED:
      nextState.status = 'released';
      break;
    case EVENTS.BOOKING_CONFIRMED:
      nextState.status = 'booking_confirmed';
      break;
    case EVENTS.BOOKING_CANCELLED:
      nextState.status = 'cancelled';
      break;
    default:
      // Silently ignore or forward unknown event types
      break;
  }

  nextState.version = event.version;
  return nextState;
}

/**
 * Rebuilds the current state of a booking by loading and applying its entire event stream.
 * 
 * PROOF OF CONCEPT COMMENT:
 * This function proves Booking state is derived from its event stream, never stored directly.
 * By fetching the event log ordered by version and reducing it with the pure applyEvent
 * function, we reconstruct the latest domain object state dynamically on-demand.
 */
export async function rebuildState(streamId, db = undefined) {
  const events = await getEventStream(streamId, db);
  return events.reduce((state, event) => {
    return applyEvent(state, event);
  }, { ...initialState });
}

/**
 * Rebuilds the booking aggregate state using the latest available snapshot,
 * replaying only events that occurred after the snapshot version.
 * Falls back to full event replay if no snapshot exists.
 */
export async function rebuildStateWithSnapshot(streamId, db = undefined) {
  const client = db || pool;

  const snapshotQuery = `
    SELECT version, state
    FROM aggregate_snapshots
    WHERE stream_id = $1
    ORDER BY version DESC
    LIMIT 1
  `;
  const snapshotRes = await client.query(snapshotQuery, [streamId]);

  if (snapshotRes.rows.length > 0) {
    const { version: snapshotVersion, state: snapshotState } = snapshotRes.rows[0];
    console.log(`Using snapshot at version ${snapshotVersion} for stream ${streamId}`);

    const eventsQuery = `
      SELECT id, stream_id, version, event_type, payload, metadata, created_at
      FROM event_log
      WHERE stream_id = $1 AND version > $2
      ORDER BY version ASC
    `;
    const eventsRes = await client.query(eventsQuery, [streamId, snapshotVersion]);

    return eventsRes.rows.reduce((state, event) => {
      return applyEvent(state, event);
    }, snapshotState);
  }

  // Fallback to full replay
  console.log(`No snapshot found, full replay for stream ${streamId}`);
  return rebuildState(streamId, client);
}

/**
 * Conditionally takes a snapshot of the current state of a booking aggregate
 * if the version matches the threshold (every 5 versions).
 */
export async function maybeSnapshot(streamId, currentState, db = undefined) {
  if (currentState.version > 0 && currentState.version % 5 === 0) {
    const client = db || pool;
    const query = `
      INSERT INTO aggregate_snapshots (stream_id, version, state, created_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (stream_id, version) DO NOTHING;
    `;
    await client.query(query, [streamId, currentState.version, JSON.stringify(currentState)]);
  }
}
