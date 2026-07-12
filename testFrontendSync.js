import WebSocket from 'ws';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/taptoturf_dev'
});

async function run() {
  console.log('--- Starting End-to-End WebSocket & Projection Sync Test ---');
  
  // 1. Fetch a real court ID from PostgreSQL
  const courtRes = await pool.query("SELECT id FROM courts WHERE name = 'Court 1' LIMIT 1");
  if (courtRes.rows.length === 0) {
    throw new Error('No seeded courts found. Run migrations and seed data first.');
  }
  const courtId = courtRes.rows[0].id;
  const userId = '7cdb7d4a-1a65-4080-9da2-7ac244e27d79';
  const bookingDate = '2026-08-08';
  const startHour = 10;
  
  console.log(`Using Court ID: ${courtId}, User ID: ${userId}`);

  // Clean old entries for this slot
  await pool.query("DELETE FROM event_log WHERE payload->>'courtId' = $1 AND payload->>'bookingDate' = $2 AND (payload->>'startHour')::int = $3", [courtId, bookingDate, startHour]);
  await pool.query("DELETE FROM availability_view WHERE court_id = $1 AND booking_date = $2 AND start_hour = $3", [courtId, bookingDate, startHour]);

  // 2. Connect to WS Gateway
  const wsUrl = 'ws://localhost:3100';
  console.log(`Connecting to WebSocket Gateway: ${wsUrl}`);
  const ws = new WebSocket(wsUrl);
  
  let wsEventReceived = null;
  
  await new Promise((resolve, reject) => {
    ws.on('open', () => {
      console.log('Connected to WebSocket server.');
      resolve();
    });
    ws.on('error', (err) => {
      reject(new Error(`WebSocket connection failed: ${err.message}`));
    });
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      console.log('[WebSocket Client] Received:', msg);
      if (msg.type === 'EVENT' && msg.eventType === 'SLOTS_RESERVED') {
        wsEventReceived = msg;
      }
    } catch (e) {
      console.error('Error parsing WS message:', e.message);
    }
  });

  // 3. Fire Reservation API request
  console.log('Sending slot reservation HTTP request to Express API server...');
  const response = await fetch('http://localhost:3000/api/bookings/reserve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      courtId,
      userId,
      bookingDate,
      startHour,
      durationHours: 2
    })
  });

  console.log(`API Response Status: ${response.status}`);
  if (response.status !== 201) {
    const err = await response.text();
    throw new Error(`Reservation failed: ${err}`);
  }
  const body = await response.json();
  console.log('Reservation succeeded. Stream ID:', body.streamId);

  // 4. Wait for WebSocket message and Postgres projection update
  console.log('Waiting for WebSocket event broadcast and database projection sync...');
  let success = false;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 250));
    
    // Check DB availability_view
    const dbRes = await pool.query('SELECT status FROM availability_view WHERE court_id = $1 AND booking_date = $2 AND start_hour = $3', [courtId, bookingDate, startHour]);
    const dbStatus = dbRes.rows[0]?.status;
    
    if (wsEventReceived && dbStatus === 'reserved') {
      console.log('SUCCESS: WebSocket event broadcast matches and DB read view updated!');
      console.log('WS Event details:', wsEventReceived);
      console.log('DB view status:', dbStatus);
      success = true;
      break;
    }
  }

  ws.close();
  await pool.end();

  if (!success) {
    throw new Error('TIMEOUT: Did not receive WS broadcast or DB projection update.');
  }
  console.log('--- End-to-End WebSocket & Projection Sync Test Passed ---');
}

run().catch(err => {
  console.error('Test FAILED:', err.message);
  pool.end();
  process.exit(1);
});
