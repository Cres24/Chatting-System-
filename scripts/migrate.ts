import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";

async function loadEnvLocal(): Promise<void> {
  try {
    const text = await readFile(path.join(process.cwd(), ".env.local"), "utf8");
    for (const line of text.split("\n")) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key] !== undefined) continue;
      process.env[key] = rawValue.replace(/^["']|["']$/g, "");
    }
  } catch {
    /* .env.local is optional */
  }
}

async function main(): Promise<void> {
  await loadEnvLocal();
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set (add it to .env.local).");
  }

  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const dir = path.join(process.cwd(), "db", "migrations");
    const files = (await readdir(dir)).filter((file) => file.endsWith(".sql")).sort();

    for (const file of files) {
      const applied = await client.query("SELECT 1 FROM _migrations WHERE name = $1", [file]);
      if (applied.rowCount) {
        console.log(`skip   ${file}`);
        continue;
      }

      const sql = await readFile(path.join(dir, file), "utf8");
      console.log(`apply  ${file}`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO _migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    console.log("Migrations up to date.");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
