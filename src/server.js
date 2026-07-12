import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { pool, appendEvent, getEventStream, ConcurrencyError } from './eventStore.js';
import { rebuildState } from './bookingAggregate.js';
import { hasOverlap } from './availability.js';
import { startRelay } from './outbox/outboxRelay.js';
import { register, commandRequestsCounter, commandDurationHistogram, concurrencyConflictsCounter } from './metrics.js';

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || 'taptoturf_secret';

// Middleware: Authentication
export function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Authentication required. No token provided.' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // { id, role }
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid or expired token.' });
  }
}

// Middleware: Admin role check
export function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Authentication required. No token provided.' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied. Administrator privileges required.' });
    }
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid or expired token.' });
  }
}

const app = express();

const allowedOrigins = new Set([
  'http://localhost:5173',
  process.env.FRONTEND_URL
].filter(Boolean));

app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.has(origin)) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

app.use(express.json());

// Prometheus request instrumentation middleware
app.use((req, res, next) => {
  if (req.path === '/metrics') {
    return next();
  }

  const start = process.hrtime();

  res.on('finish', () => {
    const diff = process.hrtime(start);
    const durationSeconds = diff[0] + diff[1] / 1e9;
    const endpoint = req.route ? req.route.path : req.path;
    const statusCode = res.statusCode.toString();

    commandRequestsCounter.inc({ endpoint, status_code: statusCode });
    commandDurationHistogram.observe({ endpoint }, durationSeconds);
  });

  next();
});

// Helper function to query a court and its corresponding turf
async function getCourtAndTurf(courtId, db = pool) {
  const courtRes = await db.query(
    'SELECT id, turf_id, base_price_per_hour FROM courts WHERE id = $1',
    [courtId]
  );
  if (courtRes.rows.length === 0) {
    return null;
  }
  const court = courtRes.rows[0];

  const turfRes = await db.query(
    'SELECT opens_at, closes_at FROM turfs WHERE id = $1',
    [court.turf_id]
  );
  if (turfRes.rows.length === 0) {
    return null;
  }
  const turf = turfRes.rows[0];

  return { court, turf };
}

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  const { name, email, phone, password } = req.body;

  if (!name || !email || !phone || !password) {
    return res.status(400).json({ message: 'Missing required registration fields.' });
  }

  try {
    const userCheck = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (userCheck.rows.length > 0) {
      return res.status(400).json({ message: 'Email already registered.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const role = 'user'; // Hardcoded role to user for safety

    const result = await pool.query(
      `INSERT INTO users (name, email, phone, password_hash, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, email, role`,
      [name, email, phone, passwordHash, role]
    );

    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1d' });

    return res.status(201).json({ token, user });
  } catch (error) {
    console.error('Registration error:', error);
    return res.status(500).json({ message: 'Internal Server Error', error: error.message });
  }
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'Missing email or password.' });
  }

  try {
    const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userResult.rows.length === 0) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    const user = userResult.rows[0];
    if (!user.password_hash) {
      return res.status(401).json({ message: 'Authentication failed. Please reset password.' });
    }
    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1d' });

    return res.status(200).json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ message: 'Internal Server Error', error: error.message });
  }
});

// POST /api/bookings/reserve
app.post('/api/bookings/reserve', requireAuth, async (req, res) => {
  const { courtId, bookingDate, startHour, durationHours } = req.body;
  const userId = req.user.id;

  if (!courtId || !userId || !bookingDate || startHour === undefined || !durationHours) {
    return res.status(400).json({ message: 'Missing required parameters.' });
  }

  const client = await pool.connect();

  try {
    // 1. Fetch court & turf
    const data = await getCourtAndTurf(courtId, client);
    if (!data) {
      return res.status(400).json({ message: 'Invalid courtId or turf reference.' });
    }
    const { court, turf } = data;

    // 2. Validate operating hours
    const openHour = parseInt(turf.opens_at.split(':')[0], 10);
    const closeHour = parseInt(turf.closes_at.split(':')[0], 10);
    const reqStart = parseInt(startHour, 10);
    const reqEnd = reqStart + parseInt(durationHours, 10);

    if (reqStart < openHour || reqEnd > closeHour || reqStart >= reqEnd || parseInt(durationHours, 10) <= 0) {
      return res.status(400).json({
        message: `Requested slot is outside operating hours (${turf.opens_at} - ${turf.closes_at}).`
      });
    }

    // 3. Start transaction & acquire advisory lock for serialization
    await client.query('BEGIN');
    
    // Hash key represents unique court & date lock to serialize simultaneous checks
    const lockKey = `${courtId}_${bookingDate}`;
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey]);

    // 4. Overlap Check
    const { hasOverlap: isOverlapping, conflictingStreamIds } = await hasOverlap(
      courtId,
      bookingDate,
      reqStart,
      durationHours,
      client
    );

    if (isOverlapping) {
      await client.query('ROLLBACK');
      concurrencyConflictsCounter.inc({ cause: 'slot_overlap' });
      return res.status(409).json({
        message: 'Requested slot overlaps an existing booking.',
        conflictingStreamIds
      });
    }

    // 5. Append SLOTS_RESERVED
    const streamId = crypto.randomUUID();
    const totalAmount = parseFloat(court.base_price_per_hour) * parseInt(durationHours, 10);
    const reservationExpiresAt = req.body.reservationExpiresAt || new Date(Date.now() + 5 * 60 * 1000).toISOString();

    const payload = {
      courtId,
      userId,
      bookingDate,
      startHour: reqStart,
      durationHours: parseInt(durationHours, 10),
      totalAmount,
      reservationExpiresAt
    };

    if (process.env.TEST_ARTIFICIAL_DELAY_MS) {
      const delay = parseInt(process.env.TEST_ARTIFICIAL_DELAY_MS, 10);
      console.log(`[TEST] Introducing artificial delay of ${delay}ms before appending/committing...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    // Append event using the transaction client connection
    const event = await appendEvent(streamId, 0, 'SLOTS_RESERVED', payload, {}, client);

    await client.query('COMMIT');

    // [Decoupled] Redis publish handled asynchronously by Transactional Outbox Relay.
    // Decoupling command latency from Redis availability/latency.

    return res.status(201).json({
      streamId,
      status: 'reserved',
      totalAmount,
      reservationExpiresAt
    });

  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Failed to rollback transaction:', rollbackError);
    }
    console.error('Error during reservation transaction:', error);
    return res.status(500).json({ message: 'Internal Server Error', error: error.message });
  } finally {
    client.release();
  }
});

// POST /api/bookings/:streamId/initiate-payment
app.post('/api/bookings/:streamId/initiate-payment', requireAuth, async (req, res) => {
  const { streamId } = req.params;

  try {
    const events = await getEventStream(streamId);
    if (!events || events.length === 0) {
      return res.status(404).json({ message: 'Booking not found.' });
    }

    const state = await rebuildState(streamId);
    if (state.userId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied. You do not own this booking.' });
    }

    if (state.status !== 'reserved') {
      return res.status(400).json({ message: `Cannot initiate payment. Booking status is '${state.status}'.` });
    }

    // Extract reservationExpiresAt from SLOTS_RESERVED event
    const reservedEvent = events.find(e => e.event_type === 'SLOTS_RESERVED');
    const expiresAt = reservedEvent?.payload?.reservationExpiresAt;

    if (expiresAt && new Date() > new Date(expiresAt)) {
      return res.status(410).json({ message: 'Reservation hold has expired.' });
    }

    // Append PAYMENT_INITIATED at current version
    const event = await appendEvent(streamId, state.version, 'PAYMENT_INITIATED', {});
    // [Decoupled] Redis publish handled asynchronously by Transactional Outbox Relay.
    
    // Rebuild final state to return
    const updatedState = await rebuildState(streamId);
    return res.status(200).json(updatedState);

  } catch (error) {
    if (error instanceof ConcurrencyError) {
      return res.status(409).json({ message: error.message });
    }
    console.error('Error during initiate payment:', error);
    return res.status(500).json({ message: 'Internal Server Error', error: error.message });
  }
});

// POST /api/bookings/:streamId/confirm-payment
app.post('/api/bookings/:streamId/confirm-payment', requireAuth, async (req, res) => {
  const { streamId } = req.params;

  try {
    const state = await rebuildState(streamId);
    if (state.userId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied. You do not own this booking.' });
    }

    if (state.status !== 'payment_pending') {
      return res.status(400).json({ message: `Cannot confirm payment. Booking status is '${state.status}'.` });
    }

    // Append PAYMENT_CONFIRMED
    const versionAfterPayment = state.version + 1;
    const event1 = await appendEvent(streamId, state.version, 'PAYMENT_CONFIRMED', {});
    // [Decoupled] Redis publish handled asynchronously by Transactional Outbox Relay.

    // Append BOOKING_CONFIRMED
    let event2;
    try {
      event2 = await appendEvent(streamId, versionAfterPayment, 'BOOKING_CONFIRMED', {});
      // [Decoupled] Redis publish handled asynchronously by Transactional Outbox Relay.
    } catch (innerError) {
      if (innerError instanceof ConcurrencyError) {
        console.error(`PARTIAL CONFIRMATION ERROR: PAYMENT_CONFIRMED succeeded at version ${versionAfterPayment}, but BOOKING_CONFIRMED failed with ConcurrencyError at version ${versionAfterPayment + 1} on stream ${streamId}`);
        return res.status(500).json({
          message: 'Partial confirmation occurred. Payment confirmed, but booking confirmation failed due to concurrency conflict. Manual recovery required.',
          streamId
        });
      }
      throw innerError;
    }

    const updatedState = await rebuildState(streamId);
    return res.status(200).json(updatedState);

  } catch (error) {
    if (error instanceof ConcurrencyError) {
      return res.status(409).json({ message: error.message });
    }
    console.error('Error during confirm payment:', error);
    return res.status(500).json({ message: 'Internal Server Error', error: error.message });
  }
});

// POST /api/bookings/:streamId/fail-payment
app.post('/api/bookings/:streamId/fail-payment', requireAuth, async (req, res) => {
  const { streamId } = req.params;

  try {
    const state = await rebuildState(streamId);
    if (state.userId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied. You do not own this booking.' });
    }

    if (state.status !== 'payment_pending') {
      return res.status(400).json({ message: `Cannot fail payment. Booking status is '${state.status}'.` });
    }

    const event = await appendEvent(streamId, state.version, 'PAYMENT_FAILED', {});
    // [Decoupled] Redis publish handled asynchronously by Transactional Outbox Relay.

    const updatedState = await rebuildState(streamId);
    return res.status(200).json(updatedState);

  } catch (error) {
    if (error instanceof ConcurrencyError) {
      return res.status(409).json({ message: error.message });
    }
    console.error('Error during fail payment:', error);
    return res.status(500).json({ message: 'Internal Server Error', error: error.message });
  }
});

// POST /api/bookings/:streamId/cancel
app.post('/api/bookings/:streamId/cancel', requireAuth, async (req, res) => {
  const { streamId } = req.params;

  try {
    const state = await rebuildState(streamId);
    if (state.userId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied. You do not own this booking.' });
    }

    const allowedStatuses = ['reserved', 'payment_pending', 'confirmed', 'booking_confirmed'];
    
    if (!allowedStatuses.includes(state.status)) {
      return res.status(400).json({ message: `Cannot cancel booking. Booking status is '${state.status}'.` });
    }

    let cancelEventType;
    if (state.status === 'reserved' || state.status === 'payment_pending') {
      cancelEventType = 'SLOTS_RELEASED';
    } else {
      cancelEventType = 'BOOKING_CANCELLED';
    }

    const event = await appendEvent(streamId, state.version, cancelEventType, {});
    // [Decoupled] Redis publish handled asynchronously by Transactional Outbox Relay.

    const updatedState = await rebuildState(streamId);
    return res.status(200).json(updatedState);

  } catch (error) {
    if (error instanceof ConcurrencyError) {
      return res.status(409).json({ message: error.message });
    }
    console.error('Error during cancellation:', error);
    return res.status(500).json({ message: 'Internal Server Error', error: error.message });
  }
});

// GET /api/bookings/:streamId
app.get('/api/bookings/:streamId', requireAuth, async (req, res) => {
  const { streamId } = req.params;

  try {
    const events = await getEventStream(streamId);
    if (!events || events.length === 0) {
      return res.status(404).json({ message: 'Booking not found.' });
    }

    const state = await rebuildState(streamId);
    if (state.userId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied. You do not own this booking.' });
    }
    return res.status(200).json(state);
  } catch (error) {
    console.error('Error fetching booking:', error);
    return res.status(500).json({ message: 'Internal Server Error', error: error.message });
  }
});

// GET /api/availability?courtId=X&date=Y
app.get('/api/availability', async (req, res) => {
  const { courtId, date } = req.query;

  if (!courtId || !date) {
    return res.status(400).json({ message: 'Missing courtId or date query parameters.' });
  }

  try {
    const result = await pool.query(
      'SELECT * FROM availability_view WHERE court_id = $1 AND booking_date = $2',
      [courtId, date]
    );
    return res.status(200).json(result.rows);
  } catch (error) {
    console.error('Error fetching availability view:', error);
    return res.status(500).json({ message: 'Internal Server Error', error: error.message });
  }
});

// GET /api/users/:userId/bookings
app.get('/api/users/:userId/bookings', requireAuth, async (req, res) => {
  const { userId } = req.params;

  if (req.user.id !== userId && req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Access denied. You cannot view bookings for another user.' });
  }

  try {
    const result = await pool.query(
      `SELECT h.*, c.name AS court_name, c.sport_type
       FROM booking_history_view h
       JOIN courts c ON h.court_id = c.id
       WHERE h.user_id = $1
       ORDER BY h.last_updated_at DESC`,
      [userId]
    );
    return res.status(200).json(result.rows);
  } catch (error) {
    console.error('Error fetching booking history view:', error);
    return res.status(500).json({ message: 'Internal Server Error', error: error.message });
  }
});

// GET /api/courts
app.get('/api/courts', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.id, c.name, c.sport_type, c.base_price_per_hour, t.name AS turf_name
      FROM courts c
      JOIN turfs t ON c.turf_id = t.id
      ORDER BY c.name ASC
    `);
    return res.status(200).json(result.rows);
  } catch (error) {
    console.error('Error fetching courts reference data:', error);
    return res.status(500).json({ message: 'Internal Server Error', error: error.message });
  }
});

// GET /api/users
app.get('/api/users', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, email FROM users ORDER BY name ASC');
    return res.status(200).json(result.rows);
  } catch (error) {
    console.error('Error fetching users list:', error);
    return res.status(500).json({ message: 'Internal Server Error', error: error.message });
  }
});

// GET /api/admin/stats
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const dbRes = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'booking_confirmed') as confirmed_count,
        COUNT(*) FILTER (WHERE status = 'released') as released_count,
        SUM(total_amount) FILTER (WHERE status = 'booking_confirmed') as total_revenue
      FROM booking_history_view;
    `);
    const activeRes = await pool.query(`
      SELECT COUNT(*) FROM availability_view 
      WHERE status IN ('reserved', 'payment_pending');
    `);

    const row = dbRes.rows[0] || {};
    const confirmed = parseInt(row.confirmed_count || 0, 10);
    const released = parseInt(row.released_count || 0, 10);
    const totalBookings = confirmed + released;
    const totalRevenue = parseFloat(row.total_revenue || 0);

    const cancellationRate = totalBookings > 0 
      ? parseFloat((released / totalBookings).toFixed(4))
      : 0.0;

    const activeReservations = parseInt(activeRes.rows[0].count || 0, 10);

    return res.status(200).json({
      totalBookings: confirmed,
      totalRevenue,
      activeReservations,
      cancellationRate
    });
  } catch (error) {
    console.error('Error fetching admin stats:', error);
    return res.status(500).json({ message: 'Internal Server Error', error: error.message });
  }
});

// Helper to parse Prometheus format
function parsePrometheusText(text) {
  const metrics = {};
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.startsWith('#') || !line.trim()) continue;
    const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)(?:\{([^}]+)\})?\s+([0-9e.+\-]+)/);
    if (match) {
      const name = match[1];
      const labelsStr = match[2];
      const value = parseFloat(match[3]);
      const labels = {};
      if (labelsStr) {
        const pairs = labelsStr.split(',');
        for (const pair of pairs) {
          const parts = pair.split('=');
          if (parts.length === 2) {
            labels[parts[0].trim()] = parts[1].trim().replace(/^"|"$/g, '');
          }
        }
      }
      if (!metrics[name]) metrics[name] = [];
      metrics[name].push({ value, labels });
    }
  }
  return metrics;
}

// GET /api/admin/metrics-snapshot
app.get('/api/admin/metrics-snapshot', requireAdmin, async (req, res) => {
  try {
    const endpoints = [
      'http://localhost:3000/metrics',
      'http://localhost:3011/metrics',
      'http://localhost:3012/metrics',
      'http://localhost:3013/metrics'
    ];

    const results = await Promise.allSettled(
      endpoints.map(url => fetch(url).then(r => r.text()))
    );

    let mergedMetrics = {};
    results.forEach(result => {
      if (result.status === 'fulfilled') {
        const parsed = parsePrometheusText(result.value);
        for (const [name, list] of Object.entries(parsed)) {
          if (!mergedMetrics[name]) mergedMetrics[name] = [];
          mergedMetrics[name].push(...list);
        }
      }
    });

    let commandRequestsTotal = 0;
    if (mergedMetrics['command_requests_total']) {
      commandRequestsTotal = mergedMetrics['command_requests_total'].reduce((sum, item) => sum + item.value, 0);
    }

    let outboxPendingTotal = 0;
    if (mergedMetrics['outbox_pending_total']) {
      outboxPendingTotal = Math.max(0, ...mergedMetrics['outbox_pending_total'].map(item => item.value));
    }

    let concurrencyConflictsTotal = 0;
    if (mergedMetrics['concurrency_conflicts_total']) {
      concurrencyConflictsTotal = mergedMetrics['concurrency_conflicts_total'].reduce((sum, item) => sum + item.value, 0);
    }

    let availabilityLag = 0.0;
    let historyLag = 0.0;
    if (mergedMetrics['projection_lag_seconds_sum'] && mergedMetrics['projection_lag_seconds_count']) {
      const sums = mergedMetrics['projection_lag_seconds_sum'];
      const counts = mergedMetrics['projection_lag_seconds_count'];
      
      const getLag = (name) => {
        const sumItem = sums.find(item => item.labels.projection_name === name);
        const countItem = counts.find(item => item.labels.projection_name === name);
        if (sumItem && countItem && countItem.value > 0) {
          return parseFloat((sumItem.value / countItem.value).toFixed(4));
        }
        return 0.0;
      };
      
      availabilityLag = getLag('availability');
      historyLag = getLag('booking_history');
    }

    return res.status(200).json({
      timestamp: new Date().toISOString(),
      commandRequestsTotal,
      outboxPendingTotal,
      concurrencyConflictsTotal,
      projectionLagSeconds: {
        availability: availabilityLag,
        booking_history: historyLag
      }
    });
  } catch (error) {
    console.error('Error generating metrics snapshot:', error);
    return res.status(500).json({ message: 'Internal Server Error', error: error.message });
  }
});

// GET /api/admin/rebuild-projections (SSE event stream)
app.get('/api/admin/rebuild-projections', async (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.status(401).json({ message: 'Authentication required.' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied.' });
    }
  } catch (error) {
    return res.status(401).json({ message: 'Invalid or expired token.' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const client = await pool.connect();
  try {
    const { rebuildBothProjections } = await import('./projections/rebuildProjection.js');
    await client.query('BEGIN');
    
    await rebuildBothProjections(client, (current, total) => {
      res.write(`data: ${JSON.stringify({ type: 'progress', current, total })}\n\n`);
    });

    await client.query('COMMIT');
    res.write(`data: ${JSON.stringify({ type: 'complete', message: 'Rebuild completed successfully.' })}\n\n`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[SSE Rebuild] Error during projection rebuild:', error);
    res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
  } finally {
    client.release();
    res.end();
  }
});



// GET /metrics
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).end(err.message);
  }
});

// Run server only if executed directly
const isMain = process.argv[1] && (
  process.argv[1].endsWith('server.js') || 
  process.argv[1].endsWith('src/server.js')
);

// --- Admin CRUD Endpoints ---

// Turf CRUD
app.get('/api/admin/turfs', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM turfs ORDER BY name ASC');
    return res.status(200).json(result.rows);
  } catch (error) {
    return res.status(500).json({ message: 'Error fetching turfs', error: error.message });
  }
});

app.post('/api/admin/turfs', requireAdmin, async (req, res) => {
  const { name, city, address, opensAt, closesAt } = req.body;
  if (!name || !city || !address || !opensAt || !closesAt) {
    return res.status(400).json({ message: 'Missing required turf fields.' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO turfs (name, city, address, opens_at, closes_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [name, city, address, opensAt, closesAt]
    );
    return res.status(201).json(result.rows[0]);
  } catch (error) {
    return res.status(500).json({ message: 'Error creating turf', error: error.message });
  }
});

app.put('/api/admin/turfs/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { name, city, address, opensAt, closesAt } = req.body;
  try {
    const result = await pool.query(
      `UPDATE turfs SET name = $1, city = $2, address = $3, opens_at = $4, closes_at = $5
       WHERE id = $6
       RETURNING *`,
      [name, city, address, opensAt, closesAt, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Turf not found.' });
    return res.status(200).json(result.rows[0]);
  } catch (error) {
    return res.status(500).json({ message: 'Error updating turf', error: error.message });
  }
});

app.delete('/api/admin/turfs/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    // 1. Check if the turf exists
    const turfCheck = await pool.query('SELECT * FROM turfs WHERE id = $1', [id]);
    if (turfCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Turf not found.' });
    }

    // 2. Count courts referencing this turf
    const courtCountResult = await pool.query('SELECT count(*) FROM courts WHERE turf_id = $1', [id]);
    const courtCount = parseInt(courtCountResult.rows[0].count, 10);

    // 3. Count booking history for courts under this turf
    const historyCountResult = await pool.query(
      `SELECT count(*) FROM booking_history_view bhv 
       JOIN courts c ON bhv.court_id = c.id 
       WHERE c.turf_id = $1`,
      [id]
    );
    const historyCount = parseInt(historyCountResult.rows[0].count, 10);

    if (historyCount > 0) {
      return res.status(409).json({
        message: `Cannot delete turf: ${courtCount} court(s) under this turf have existing booking history. Delete or reassign those courts first.`
      });
    }

    if (courtCount > 0) {
      return res.status(409).json({
        message: `Cannot delete turf: ${courtCount} court(s) still exist under this turf. Delete all courts first.`
      });
    }

    const result = await pool.query('DELETE FROM turfs WHERE id = $1 RETURNING *', [id]);
    return res.status(200).json({ message: 'Turf deleted successfully.' });
  } catch (error) {
    return res.status(500).json({ message: 'Error deleting turf', error: error.message });
  }
});

// Court CRUD
app.get('/api/admin/courts', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM courts ORDER BY name ASC');
    return res.status(200).json(result.rows);
  } catch (error) {
    return res.status(500).json({ message: 'Error fetching courts', error: error.message });
  }
});

app.post('/api/admin/courts', requireAdmin, async (req, res) => {
  const { turfId, sportType, name, basePricePerHour } = req.body;
  if (!turfId || !sportType || !name || !basePricePerHour) {
    return res.status(400).json({ message: 'Missing required court fields.' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO courts (turf_id, sport_type, name, base_price_per_hour)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [turfId, sportType, name, basePricePerHour]
    );
    return res.status(201).json(result.rows[0]);
  } catch (error) {
    return res.status(500).json({ message: 'Error creating court', error: error.message });
  }
});

app.put('/api/admin/courts/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { turfId, sportType, name, basePricePerHour } = req.body;
  try {
    const result = await pool.query(
      `UPDATE courts SET turf_id = $1, sport_type = $2, name = $3, base_price_per_hour = $4
       WHERE id = $5
       RETURNING *`,
      [turfId, sportType, name, basePricePerHour, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Court not found.' });
    return res.status(200).json(result.rows[0]);
  } catch (error) {
    return res.status(500).json({ message: 'Error updating court', error: error.message });
  }
});

app.delete('/api/admin/courts/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const historyCheck = await pool.query('SELECT count(*) FROM booking_history_view WHERE court_id = $1', [id]);
    if (parseInt(historyCheck.rows[0].count, 10) > 0) {
      return res.status(409).json({ message: 'Cannot delete court. Existing booking history exists for this court.' });
    }

    const result = await pool.query('DELETE FROM courts WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) return res.status(404).json({ message: 'Court not found.' });
    return res.status(200).json({ message: 'Court deleted successfully.' });
  } catch (error) {
    return res.status(500).json({ message: 'Error deleting court', error: error.message });
  }
});

// GET /api/events?eventType=X&streamId=Y&limit=50&offset=0
app.get('/api/events', requireAuth, async (req, res) => {
  const { eventType, streamId, limit = 50, offset = 0 } = req.query;

  try {
    const conditions = [];
    const params = [];

    // 1. Non-admin users are restricted to viewing only their own streams.
    // We join against booking_history_view and search for the creator userId in SLOTS_RESERVED payload.
    if (req.user.role !== 'admin') {
      params.push(req.user.id);
      conditions.push(`COALESCE(bhv.user_id, (el2.payload->>'userId')::uuid) = $${params.length}`);
    }

    if (eventType && eventType !== 'ALL') {
      params.push(eventType);
      conditions.push(`el.event_type = $${params.length}`);
    }

    if (streamId && streamId.trim() !== '') {
      params.push(streamId.trim());
      conditions.push(`el.stream_id = $${params.length}`);
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    // Count the total number of distinct stream IDs matching filters
    const countQueryText = `
      SELECT COUNT(DISTINCT el.stream_id)
      FROM event_log el
      LEFT JOIN booking_history_view bhv ON bhv.stream_id = el.stream_id
      LEFT JOIN event_log el2 ON el2.stream_id = el.stream_id AND el2.event_type = 'SLOTS_RESERVED'
      ${whereClause}
    `;
    const countResult = await pool.query(countQueryText, params);
    const totalCount = parseInt(countResult.rows[0].count, 10);

    // Get the distinct stream IDs paginated, ordered by their latest event timestamp descending
    const paginateParams = [...params];
    paginateParams.push(parseInt(limit, 10));
    const limitIndex = paginateParams.length;
    paginateParams.push(parseInt(offset, 10));
    const offsetIndex = paginateParams.length;

    const streamsQueryText = `
      SELECT el.stream_id, MAX(el.created_at) AS latest_created_at
      FROM event_log el
      LEFT JOIN booking_history_view bhv ON bhv.stream_id = el.stream_id
      LEFT JOIN event_log el2 ON el2.stream_id = el.stream_id AND el2.event_type = 'SLOTS_RESERVED'
      ${whereClause}
      GROUP BY el.stream_id
      ORDER BY latest_created_at DESC
      LIMIT $${limitIndex} OFFSET $${offsetIndex}
    `;
    const streamsResult = await pool.query(streamsQueryText, paginateParams);
    const streamIds = streamsResult.rows.map(r => r.stream_id);

    if (streamIds.length === 0) {
      return res.status(200).json({
        streams: [],
        totalCount,
        limit: parseInt(limit, 10),
        offset: parseInt(offset, 10)
      });
    }

    // Fetch all events for the paginated stream IDs, joining user names for admins
    const eventsQueryText = `
      SELECT 
        el.id, 
        el.stream_id, 
        el.version, 
        el.event_type, 
        el.payload, 
        el.metadata, 
        el.created_at,
        u.name AS user_name,
        u.email AS user_email
      FROM event_log el
      LEFT JOIN booking_history_view bhv ON bhv.stream_id = el.stream_id
      LEFT JOIN event_log el2 ON el2.stream_id = el.stream_id AND el2.event_type = 'SLOTS_RESERVED'
      LEFT JOIN users u ON u.id = COALESCE(bhv.user_id, (el2.payload->>'userId')::uuid)
      WHERE el.stream_id = ANY($1)
      ORDER BY el.stream_id, el.version ASC
    `;
    const eventsResult = await pool.query(eventsQueryText, [streamIds]);

    // Group rows into streams
    const streamsMap = {};
    for (const id of streamIds) {
      streamsMap[id] = {
        streamId: id,
        userName: null,
        userEmail: null,
        events: []
      };
    }

    for (const row of eventsResult.rows) {
      const sId = row.stream_id;
      if (streamsMap[sId]) {
        if (row.user_name) streamsMap[sId].userName = row.user_name;
        if (row.user_email) streamsMap[sId].userEmail = row.user_email;
        streamsMap[sId].events.push({
          id: row.id,
          stream_id: row.stream_id,
          version: row.version,
          event_type: row.event_type,
          payload: row.payload,
          metadata: row.metadata,
          created_at: row.created_at
        });
      }
    }

    const streams = streamIds.map(id => {
      const streamData = streamsMap[id];
      streamData.events.sort((a, b) => a.version - b.version);
      
      const latestEvent = streamData.events[streamData.events.length - 1];
      streamData.latestEvent = latestEvent;

      const reservationEvent = streamData.events.find(e => e.event_type === 'SLOTS_RESERVED');
      if (reservationEvent && reservationEvent.payload) {
        streamData.bookingDetails = {
          courtId: reservationEvent.payload.courtId,
          bookingDate: reservationEvent.payload.bookingDate,
          startHour: reservationEvent.payload.startHour,
          durationHours: reservationEvent.payload.durationHours,
          totalAmount: reservationEvent.payload.totalAmount
        };
      }

      // regular users must not see user details (prevent exposing identity)
      if (req.user.role !== 'admin') {
        delete streamData.userName;
        delete streamData.userEmail;
      }

      return streamData;
    });

    return res.status(200).json({
      streams,
      totalCount,
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10)
    });
  } catch (error) {
    console.error('Error fetching event logs:', error);
    return res.status(500).json({ message: 'Internal Server Error', error: error.message });
  }
});

// GET /api/events/streams/:streamId
app.get('/api/events/streams/:streamId', requireAuth, async (req, res) => {
  const { streamId } = req.params;

  try {
    const result = await pool.query(
      `SELECT id, stream_id, version, event_type, payload, metadata, created_at
       FROM event_log
       WHERE stream_id = $1
       ORDER BY version ASC`
    , [streamId]);
    return res.status(200).json(result.rows);
  } catch (error) {
    console.error('Error fetching events for stream:', error);
    return res.status(500).json({ message: 'Internal Server Error', error: error.message });
  }
});

// Wrap app.listen to automatically manage background Transactional Outbox Relay loop
const originalListen = app.listen;
let activeRelay = null;

app.listen = function(...args) {
  if (process.env.DISABLE_OUTBOX_RELAY !== 'true') {
    // Start the outbox relay background loop
    activeRelay = startRelay();
  } else {
    console.log('[server] Transactional Outbox Relay is disabled via DISABLE_OUTBOX_RELAY=true');
  }

  const serverInstance = originalListen.apply(this, args);

  // Stop outbox relay when server is closed
  const originalClose = serverInstance.close;
  serverInstance.close = function(cb) {
    if (activeRelay) {
      activeRelay.stop();
      activeRelay = null;
    }
    return originalClose.call(this, cb);
  };

  return serverInstance;
};

let server;
if (isMain) {
  const PORT = process.env.PORT || 3000;
  server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Express Command API listening on port ${PORT}`);
  });
}

export { app, server };
