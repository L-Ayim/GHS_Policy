import fs from "node:fs/promises";
import path from "node:path";
import { withClient } from "./lib/db.mjs";

const migrationsDir = path.resolve(process.cwd(), "db", "migrations");

await withClient(async (client) => {
  await client.query("begin");

  try {
    await client.query(`
      create table if not exists schema_migrations (
        version text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    const applied = new Set(
      (await client.query("select version from schema_migrations")).rows.map((row) => row.version)
    );
    const files = (await fs.readdir(migrationsDir))
      .filter((file) => file.endsWith(".sql"))
      .sort();

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`Skipping ${file}`);
        continue;
      }

      const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
      console.log(`Applying ${file}`);
      await client.query(sql);
      await client.query("insert into schema_migrations(version) values ($1)", [file]);
    }

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
});
