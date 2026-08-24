import pg from "pg";
const { Pool } = pg;

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

export const query = (text, params = []) => pool.query(text, params);
