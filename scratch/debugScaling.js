import pg from 'pg';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function seed5000Events() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    console.log('Generating 5000 events...');
    const courtIds = [
      '12bbc9f4-0b6a-4fb6-b668-81025e84dfe8',
      '540afd19-fd78-4e28-93ff-2c83b38a2638',
      '5dcb68b8-167c-476e-a4b8-f1ae1f3c5f44'
    ];
    const userId = 'bf56a34c-8b4c-489c-8a4b-ac0a6fcb750b';
    
    const batchSize = 500;
    for (let batchStart = 0; batchStart < 5000; batchStart += batchSize) {
      let queryText = 'INSERT INTO event_log (id, stream_id, version, event_type, payload) VALUES ';
      const params = [];
      let paramIndex = 1;
      
      for (let i = 0; i < batchSize; i++) {
        const id = crypto.randomUUID();
        const streamId = crypto.randomUUID();
        const version = 1;
        const eventType = 'SLOTS_RESERVED';
        const payload = JSON.stringify({
          courtId: courtIds[(batchStart + i) % 3],
          userId,
          bookingDate: `2029-03-${1 + Math.floor((batchStart + i) / 10)}`,
          startHour: 8 + ((batchStart + i) % 6) * 2,
          durationHours: 2,
          reservationExpiresAt: new Date(Date.now() + 5*60*1000).toISOString()
        });
        
        if (i > 0) queryText += ', ';
        queryText += `($${paramIndex}, $${paramIndex+1}, $${paramIndex+2}, $${paramIndex+3}, $${paramIndex+4})`;
        params.push(id, streamId, version, eventType, payload);
        paramIndex += 5;
      }
      
      const insertRes = await client.query(queryText + ' RETURNING id', params);
      
      // Insert outbox rows
      let outboxQueryText = 'INSERT INTO event_outbox (event_log_id, published) VALUES ';
      const outboxParams = [];
      let outboxParamIdx = 1;
      for (let i = 0; i < batchSize; i++) {
        if (i > 0) outboxQueryText += ', ';
        outboxQueryText += `($${outboxParamIdx}, false)`;
        outboxParams.push(insertRes.rows[i].id);
        outboxParamIdx++;
      }
      await client.query(outboxQueryText, outboxParams);
    }
    
    await client.query('COMMIT');
    console.log('Seeded 5000 events.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function run() {
  await seed5000Events();
  await pool.end();
}

run().catch(console.error);
