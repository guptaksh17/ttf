import pg from 'pg';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { seed } from './seedReferenceData.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  console.log('=== TapToTurf Database Reset & Clean Seeding ===');
  const client = await pool.connect();
  
  try {
    // 1. Drop existing tables and types to guarantee absolute clean state
    console.log('Dropping all existing database tables...');
    await client.query(`
      DROP TABLE IF EXISTS 
        booking_snapshots, 
        booking_history_view, 
        availability_view, 
        event_outbox, 
        event_log, 
        users, 
        courts, 
        turfs 
      CASCADE;
    `);
    
    // 2. Read and run migrations in alphabetical order
    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      console.log(`Executing migration: ${file}`);
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
    }
    
    console.log('Migrations completed successfully.');

    // 3. Seed new clean baseline dataset (includes the 2 real users + 2 test fixture users)
    console.log('Seeding reference tables...');
    await seed(pool);
    
    console.log('=== Database Clean Reset and Seeding Completed Successfully! ===');
  } catch (err) {
    console.error('Database reset failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
