import pg from 'pg';
import dotenv from 'dotenv';
import bcrypt from 'bcrypt';
import { fileURLToPath } from 'url';
import path from 'path';

dotenv.config();

const { Pool } = pg;

export async function seed(poolInstance) {
  const pool = poolInstance || new Pool({
    connectionString: process.env.DATABASE_URL
  });

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Insert Turf
    const turfName = 'Greenfield Sports Arena';
    const turfCity = 'Chennai';
    const turfAddress = '123 ECR Road, Chennai';
    const turfOpens = '06:00';
    const turfCloses = '23:00';

    let turfId;
    const turfCheck = await client.query(
      'SELECT id FROM turfs WHERE name = $1 AND city = $2',
      [turfName, turfCity]
    );

    if (turfCheck.rows.length > 0) {
      turfId = turfCheck.rows[0].id;
      console.log(`Turf "${turfName}" already exists with ID: ${turfId}`);
    } else {
      const turfInsert = await client.query(
        `INSERT INTO turfs (name, city, address, opens_at, closes_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [turfName, turfCity, turfAddress, turfOpens, turfCloses]
      );
      turfId = turfInsert.rows[0].id;
      console.log(`Turf "${turfName}" created with ID: ${turfId}`);
    }

    // 2. Insert Courts
    const courtsToSeed = [
      { id: '12bbc9f4-0b6a-4fb6-b668-81025e84dfe8', name: 'Court 1', sport_type: 'football_5s', base_price_per_hour: 1200 },
      { id: '540afd19-fd78-4e28-93ff-2c83b38a2638', name: 'Net A', sport_type: 'box_cricket', base_price_per_hour: 900 },
      { id: '5dcb68b8-167c-476e-a4b8-f1ae1f3c5f44', name: 'Court B', sport_type: 'badminton', base_price_per_hour: 500 }
    ];

    for (const court of courtsToSeed) {
      const courtCheck = await client.query(
        'SELECT id FROM courts WHERE turf_id = $1 AND name = $2',
        [turfId, court.name]
      );

      if (courtCheck.rows.length > 0) {
        console.log(`Court "${court.name}" already exists with ID: ${courtCheck.rows[0].id}`);
      } else {
        const courtInsert = await client.query(
          `INSERT INTO courts (id, turf_id, sport_type, name, base_price_per_hour)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [court.id, turfId, court.sport_type, court.name, court.base_price_per_hour]
        );
        console.log(`Court "${court.name}" created with ID: ${courtInsert.rows[0].id}`);
      }
    }

    // 3. Insert Users
    const usersToSeed = [
      { 
        id: '7cdb7d4a-1a65-4080-9da2-7ac244e27d79',
        name: 'Kshitij Gupta', 
        email: 'kshitij@example.com', 
        phone: '+919876543210', 
        passwordHash: await bcrypt.hash('admin123', 10), 
        role: 'admin' 
      },
      { 
        id: '27042cde-b3e3-4310-931a-c54c731d6c65',
        name: 'Aditya Sen', 
        email: 'aditya@example.com', 
        phone: '+918765432109', 
        passwordHash: await bcrypt.hash('user123', 10), 
        role: 'user' 
      },
      {
        id: '3c8a9807-6b45-4df6-a67b-bf08e001550c',
        name: 'Test Fixture User 1',
        email: 'test-fixture-1@internal.test',
        phone: '+919999999991',
        passwordHash: await bcrypt.hash('fixture123', 10),
        role: 'user'
      },
      {
        id: '8c5f590b-6078-43d9-952b-4ad9e01bc6f4',
        name: 'Test Fixture User 2',
        email: 'test-fixture-2@internal.test',
        phone: '+919999999992',
        passwordHash: await bcrypt.hash('fixture123', 10),
        role: 'user'
      },
      {
        id: '5a9b8c7d-6e5f-4d3c-b2a1-f0e9d8c7b6a5',
        name: 'Site Administrator',
        email: 'admin@gmail.com',
        phone: '+910000000000',
        passwordHash: await bcrypt.hash('password', 10),
        role: 'admin'
      }
    ];

    for (const user of usersToSeed) {
      const userCheck = await client.query(
        'SELECT id FROM users WHERE email = $1',
        [user.email]
      );

      if (userCheck.rows.length > 0) {
        await client.query(
          `UPDATE users SET password_hash = $1, role = $2, name = $3, phone = $4 WHERE email = $5`,
          [user.passwordHash, user.role, user.name, user.phone, user.email]
        );
        console.log(`User "${user.name}" updated with ID: ${userCheck.rows[0].id}`);
      } else {
        const userInsert = await client.query(
          `INSERT INTO users (id, name, email, phone, password_hash, role)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [user.id, user.name, user.email, user.phone, user.passwordHash, user.role]
        );
        console.log(`User "${user.name}" created with ID: ${userInsert.rows[0].id}`);
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error during seeding:', error);
    throw error;
  } finally {
    client.release();
    if (!poolInstance) {
      await pool.end();
    }
  }
}

// Support executing directly
const isMain = process.argv[1] && (
  fileURLToPath(import.meta.url) === process.argv[1] ||
  path.basename(process.argv[1]) === 'seedReferenceData.js'
);

if (isMain) {
  console.log('Running standalone seed script...');
  seed().then(() => {
    console.log('Seeding completed successfully.');
    process.exit(0);
  }).catch((err) => {
    console.error('Seeding failed:', err);
    process.exit(1);
  });
}
