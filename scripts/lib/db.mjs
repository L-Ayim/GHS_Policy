import pg from "pg";
import { requireEnv } from "./config.mjs";

const { Pool } = pg;

export function createPool() {
  return new Pool({
    connectionString: requireEnv("DATABASE_URL"),
    ssl: { rejectUnauthorized: true }
  });
}

export async function withClient(fn) {
  const pool = createPool();
  const client = await pool.connect();

  try {
    return await fn(client);
  } finally {
    client.release();
    await pool.end();
  }
}
