import { pbkdf2Sync, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
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
    /* optional */
  }
}

function hashPassword(password: string): { hash: string; salt: string } {
  const salt = randomBytes(16).toString("hex");
  const hash = pbkdf2Sync(password, salt, 100_000, 32, "sha256").toString("hex");
  return { hash, salt };
}

const DEMO_USERS = [
  { fullName: "Aarav Sharma", username: "aarav", email: "aarav@example.com" },
  { fullName: "Bina Thapa", username: "bina", email: "bina@example.com" },
  { fullName: "Chetan Rai", username: "chetan", email: "chetan@example.com" },
];

async function main(): Promise<void> {
  await loadEnvLocal();
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set (add it to .env.local).");

  const password = process.env.SEED_PASSWORD ?? "chatdemo123";
  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query("BEGIN");

    const ids: string[] = [];
    for (const user of DEMO_USERS) {
      const { hash, salt } = hashPassword(password);
      const result = await client.query(
        `INSERT INTO users (full_name, username, email, password_hash, password_salt, password_iterations)
         VALUES ($1, $2, $3, $4, $5, 100000)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [user.fullName, user.username, user.email, hash, salt],
      );
      if (result.rows[0]) {
        ids.push(result.rows[0].id);
      } else {
        const existing = await client.query("SELECT id FROM users WHERE lower(username) = lower($1)", [
          user.username,
        ]);
        ids.push(existing.rows[0].id);
      }
    }

    const [aarav, bina, chetan] = ids;

    for (const [a, b] of [
      [aarav, bina],
      [aarav, chetan],
      [bina, chetan],
    ]) {
      await client.query(
        `INSERT INTO friendships (user_id, friend_id) VALUES ($1, $2), ($2, $1)
         ON CONFLICT DO NOTHING`,
        [a, b],
      );
    }

    const directKey = [aarav, bina].sort().join(":");
    let conversation = await client.query(
      "SELECT id FROM conversations WHERE direct_key = $1",
      [directKey],
    );
    if (!conversation.rowCount) {
      conversation = await client.query(
        `INSERT INTO conversations (type, direct_key, created_by)
         VALUES ('direct', $1, $2) RETURNING id`,
        [directKey, aarav],
      );
      await client.query(
        `INSERT INTO conversation_members (conversation_id, user_id)
         VALUES ($1, $2), ($1, $3)`,
        [conversation.rows[0].id, aarav, bina],
      );
    }

    const dmId = conversation.rows[0].id;
    const existingMessages = await client.query(
      "SELECT count(*)::int AS count FROM messages WHERE conversation_id = $1",
      [dmId],
    );
    if (existingMessages.rows[0].count === 0) {
      await client.query(
        `INSERT INTO messages (conversation_id, sender_id, kind, body)
         VALUES ($1, $2, 'text', $3), ($1, $4, 'text', $5)`,
        [dmId, aarav, "Hey Bina! Welcome to the new stack.", bina, "Thanks! This one runs on Postgres."],
      );
    }

    const group = await client.query(
      `INSERT INTO conversations (type, name, created_by)
       SELECT 'group', 'Weekend Plans', $1
       WHERE NOT EXISTS (SELECT 1 FROM conversations WHERE type = 'group' AND name = 'Weekend Plans')
       RETURNING id`,
      [aarav],
    );
    if (group.rows[0]) {
      const groupId = group.rows[0].id;
      await client.query(
        `INSERT INTO conversation_members (conversation_id, user_id, role)
         VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member')`,
        [groupId, aarav, bina, chetan],
      );
      await client.query(
        `INSERT INTO messages (conversation_id, sender_id, kind, body)
         VALUES ($1, $2, 'text', 'Anyone up for a hike this weekend?')`,
        [groupId, aarav],
      );
    }

    await client.query("COMMIT");
    console.log("Seeded demo data.");
    console.log(`Users: ${DEMO_USERS.map((u) => u.username).join(", ")}`);
    console.log(`Password: ${password}`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
