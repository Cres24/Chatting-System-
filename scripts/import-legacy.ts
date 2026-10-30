import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { put } from "@vercel/blob";
import {
  extensionFor,
  parseDataUrl,
  parseLegacyTimestamp,
  type LegacyExport,
} from "./legacy";

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

const blobToken = () => process.env.BLOB_READ_WRITE_TOKEN ?? "";
const blobAccess = (): "public" | "private" =>
  process.env.BLOB_ACCESS === "public" ? "public" : "private";

async function uploadDataUrl(
  dataUrl: string,
  prefix: string,
): Promise<string | null> {
  if (!blobToken()) return null;
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return null;

  const result = await put(
    `${prefix}/${randomUUID()}.${extensionFor(parsed.mimeType)}`,
    parsed.buffer,
    {
      access: blobAccess(),
      contentType: parsed.mimeType,
      token: blobToken(),
      addRandomSuffix: false,
    },
  );
  return result.url;
}

async function main(): Promise<void> {
  await loadEnvLocal();
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set (add it to .env.local).");
  }

  const exportPath =
    process.argv[2] ??
    process.env.LEGACY_EXPORT_PATH ??
    path.join(process.cwd(), "..", "chat-legacy-export.json");

  const raw = JSON.parse(await readFile(exportPath, "utf8")) as LegacyExport;
  console.log(`Importing ${exportPath}`);
  console.log(`  ${raw.users.length} users, ${raw.direct_messages.length} DMs, ${raw.groups.length} groups`);

  if (!blobToken()) {
    console.warn(
      "BLOB_READ_WRITE_TOKEN is not set: avatars and media attachments will be skipped.",
    );
  }

  const client = new Client({ connectionString });
  await client.connect();

  const usernameToId = new Map<string, string>();
  const legacyUserIdToName = new Map<number, string>();
  let skippedMedia = 0;

  try {
    await client.query("BEGIN");

    for (const user of raw.users) {
      legacyUserIdToName.set(user.id, user.username);
      const avatar = user.avatar?.startsWith("data:")
        ? (await uploadDataUrl(user.avatar, "legacy/avatars")) ?? ""
        : user.avatar || "";

      await client.query(
        `INSERT INTO users
           (full_name, username, email, password_hash, password_salt, password_iterations, avatar_url)
         VALUES ($1, $2, $3, $4, $5, 100000, $6)
         ON CONFLICT DO NOTHING`,
        [
          user.full_name,
          user.username,
          user.email || `${user.username.replace(/[^a-z0-9]/gi, ".").toLowerCase()}@legacy.local`,
          user.password_hash,
          user.password_salt,
          avatar,
        ],
      );

      const found = await client.query(
        "SELECT id FROM users WHERE lower(username) = lower($1)",
        [user.username],
      );
      if (found.rows[0]) usernameToId.set(user.username, found.rows[0].id);
    }

    const idFor = (username: string): string | null =>
      usernameToId.get(username) ?? null;

    const friendPairs = new Set<string>();
    for (const row of raw.friends) {
      const a = legacyUserIdToName.get(row.user_id);
      const b = legacyUserIdToName.get(row.friend_id);
      if (!a || !b) continue;
      friendPairs.add(`${a}\u0000${b}`);
      friendPairs.add(`${b}\u0000${a}`);
    }
    for (const pair of friendPairs) {
      const [a, b] = pair.split("\u0000");
      const aId = idFor(a);
      const bId = idFor(b);
      if (!aId || !bId || aId === bId) continue;
      await client.query(
        "INSERT INTO friendships (user_id, friend_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [aId, bId],
      );
    }

    for (const request of raw.friend_requests) {
      const from = idFor(request.from_user);
      const to = idFor(request.to_user);
      if (!from || !to || from === to) continue;
      await client.query(
        `INSERT INTO friend_requests (from_user, to_user, status)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [from, to, request.status || "pending"],
      );
    }

    for (const block of raw.blocked_users ?? []) {
      const blocker = idFor(block.blocker_username);
      const blocked = idFor(block.blocked_username);
      if (!blocker || !blocked) continue;
      await client.query(
        "INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [blocker, blocked],
      );
    }

    // Groups -----------------------------------------------------------------
    const legacyGroupToId = new Map<number, string>();
    for (const group of raw.groups) {
      const avatar = group.avatar?.startsWith("data:")
        ? (await uploadDataUrl(group.avatar, "legacy/groups")) ?? ""
        : group.avatar || "";
      const creator = idFor(group.creator);

      const inserted = await client.query(
        `INSERT INTO conversations (type, name, avatar_url, created_by)
         VALUES ('group', $1, $2, $3) RETURNING id`,
        [group.name, avatar, creator],
      );
      legacyGroupToId.set(group.id, inserted.rows[0].id);
    }

    for (const member of raw.group_members) {
      const conversationId = legacyGroupToId.get(member.group_id);
      const userId = idFor(member.username);
      if (!conversationId || !userId) continue;
      await client.query(
        `INSERT INTO conversation_members (conversation_id, user_id, role)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [conversationId, userId, member.role === "admin" ? "admin" : "member"],
      );
    }

    // Direct messages --------------------------------------------------------
    const dmConversation = new Map<string, string>();
    for (const message of raw.direct_messages) {
      const senderId = idFor(message.sender);
      const receiverId = idFor(message.receiver);
      if (!senderId || !receiverId) continue;

      const key = [senderId, receiverId].sort().join(":");
      let conversationId: string | null = dmConversation.get(key) ?? null;
      if (!conversationId) {
        const existing = await client.query(
          "SELECT id FROM conversations WHERE direct_key = $1",
          [key],
        );
        if (existing.rows[0]) {
          conversationId = existing.rows[0].id as string;
        } else {
          const created = await client.query(
            `INSERT INTO conversations (type, direct_key, created_by, created_at, updated_at)
             VALUES ('direct', $1, $2, $3, $3) RETURNING id`,
            [key, senderId, parseLegacyTimestamp(message.timestamp)],
          );
          conversationId = created.rows[0].id as string;
          await client.query(
            `INSERT INTO conversation_members (conversation_id, user_id)
             VALUES ($1, $2), ($1, $3)`,
            [conversationId, senderId, receiverId],
          );
        }
      }

      if (!conversationId) continue;
      dmConversation.set(key, conversationId);

      await insertLegacyMessage(client, {
        conversationId,
        senderId,
        text: message.text,
        kind: message.msg_type ?? "text",
        createdAt: parseLegacyTimestamp(message.timestamp),
        skipped: () => {
          skippedMedia += 1;
        },
      });
    }

    // Group messages ---------------------------------------------------------
    for (const message of raw.group_messages) {
      const conversationId = legacyGroupToId.get(message.group_id);
      if (!conversationId) continue;
      const senderId = idFor(message.sender);

      await insertLegacyMessage(client, {
        conversationId,
        senderId,
        text: message.text,
        kind: message.msg_type ?? "text",
        createdAt: parseLegacyTimestamp(message.timestamp),
        skipped: () => {
          skippedMedia += 1;
        },
      });
    }

    await client.query("COMMIT");
    console.log(
      `Imported ${usernameToId.size} users, ${dmConversation.size} conversations, ${legacyGroupToId.size} groups.`,
    );
    if (skippedMedia > 0) {
      console.warn(`Skipped ${skippedMedia} attachment(s) because Blob is not configured.`);
    }
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

async function insertLegacyMessage(
  client: Client,
  input: {
    conversationId: string;
    senderId: string | null;
    text: string;
    kind: string;
    createdAt: Date;
    skipped: () => void;
  },
): Promise<void> {
  const isDataUrl = input.text.startsWith("data:");
  const kind = ["text", "image", "audio", "video", "file"].includes(input.kind)
    ? input.kind
    : "text";

  let storageKey: string | null = null;
  let mimeType = "";

  if (isDataUrl) {
    if (!blobToken()) {
      input.skipped();
      return;
    }
    const parsed = parseDataUrl(input.text);
    if (!parsed) {
      input.skipped();
      return;
    }
    mimeType = parsed.mimeType;
    storageKey = await uploadDataUrl(input.text, "legacy/media");
    if (!storageKey) {
      input.skipped();
      return;
    }
  }

  const message = await client.query(
    `INSERT INTO messages (conversation_id, sender_id, kind, body, created_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      input.conversationId,
      input.senderId,
      isDataUrl ? (kind === "text" ? "file" : kind) : "text",
      isDataUrl ? "" : input.text,
      input.createdAt,
    ],
  );

  if (storageKey) {
    await client.query(
      `INSERT INTO attachments (message_id, storage_key, mime_type, size_bytes)
       VALUES ($1, $2, $3, 0)`,
      [message.rows[0].id, storageKey, mimeType],
    );
  }

  await client.query(
    "UPDATE conversations SET updated_at = $1 WHERE id = $2 AND updated_at < $1",
    [input.createdAt, input.conversationId],
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
