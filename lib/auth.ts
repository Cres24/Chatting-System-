import { createHash, pbkdf2, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { getDb } from "@/lib/db";
import { sessions, users } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { HttpError } from "@/lib/http";
import { userAvatarUrl } from "@/lib/avatars";

const pbkdf2Async = promisify(pbkdf2);

export const SESSION_COOKIE = "chat_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
/** Current recommendation for PBKDF2-HMAC-SHA256 (OWASP). */
export const CURRENT_ITERATIONS = 600_000;
/** The legacy Python server used hashlib.pbkdf2_hmac defaults. */
export const LEGACY_ITERATIONS = 100_000;

export type DbUser = typeof users.$inferSelect;

export type PublicUser = {
  id: string;
  full_name: string;
  username: string;
  email: string;
  avatar: string;
};

export function toPublicUser(user: DbUser): PublicUser {
  return {
    id: user.id,
    full_name: user.fullName,
    username: user.username,
    email: user.email,
    avatar: userAvatarUrl(user.id, user.avatarUrl),
  };
}

export async function hashPassword(
  password: string,
  iterations = CURRENT_ITERATIONS,
): Promise<{ hash: string; salt: string; iterations: number }> {
  const salt = randomBytes(16).toString("hex");
  const hash = (await pbkdf2Async(password, salt, iterations, 32, "sha256")).toString("hex");
  return { hash, salt, iterations };
}

export async function verifyPassword(
  password: string,
  hash: string,
  salt: string,
  iterations: number,
): Promise<boolean> {
  const expected = Buffer.from(hash, "hex");
  if (expected.length === 0) return false;
  const candidate = await pbkdf2Async(password, salt, iterations, expected.length, "sha256");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: string): Promise<void> {
  const db = getDb();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);

  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
  await db.insert(sessions).values({ id: hashToken(token), userId, expiresAt });

  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.production,
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    await getDb().delete(sessions).where(eq(sessions.id, hashToken(token)));
  }
  jar.delete(SESSION_COOKIE);
}

export async function getCurrentUser(): Promise<DbUser | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const rows = await getDb()
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, hashToken(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);

  return rows[0]?.user ?? null;
}

export async function requireUser(): Promise<DbUser> {
  const user = await getCurrentUser();
  if (!user) throw new HttpError(401, "Not signed in.");
  return user;
}

export async function findUserByUsername(username: string): Promise<DbUser | null> {
  if (!username) return null;
  const rows = await getDb()
    .select()
    .from(users)
    .where(sql`lower(${users.username}) = lower(${username})`)
    .limit(1);
  return rows[0] ?? null;
}

export async function findUserByIdentifier(identifier: string): Promise<DbUser | null> {
  const value = identifier.trim();
  if (!value) return null;
  const rows = await getDb()
    .select()
    .from(users)
    .where(sql`lower(${users.username}) = lower(${value}) OR lower(${users.email}) = lower(${value})`)
    .limit(1);
  return rows[0] ?? null;
}

export async function upgradePasswordIfNeeded(
  user: DbUser,
  plaintext: string,
): Promise<void> {
  if (user.passwordIterations >= CURRENT_ITERATIONS) return;
  const next = await hashPassword(plaintext);
  await getDb()
    .update(users)
    .set({
      passwordHash: next.hash,
      passwordSalt: next.salt,
      passwordIterations: next.iterations,
    })
    .where(eq(users.id, user.id));
}
