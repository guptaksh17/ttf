import pg from 'pg';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { Pool } = pg;

export async function runMigrations(connectionString = process.env.DATABASE_URL) {
  console.log('--- Running TapToTurf Database Migrations ---');
  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  try {
    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort(); // Sorts files alphabetically (e.g. 001_..., 002_...) to preserve order

    for (const file of files) {
      console.log(`Running migration: ${file}`);
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
      console.log(`Successfully completed: ${file}`);
    }
    console.log('--- All Migrations Completed Successfully ---');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

const isMain = process.argv[1] && (
  fileURLToPath(import.meta.url) === process.argv[1] ||
  path.basename(process.argv[1]) === 'dbMigrate.js'
);

if (isMain) {
  runMigrations().then(() => {
    process.exit(0);
  }).catch((err) => {
    process.exit(1);
  });
}
