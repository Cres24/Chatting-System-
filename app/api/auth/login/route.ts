import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import {
  createSession,
  findUserByIdentifier,
  toPublicUser,
  upgradePasswordIfNeeded,
  verifyPassword,
} from "@/lib/auth";
import { getDb } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { HttpError, assertSameOrigin, handle, json, parseJson } from "@/lib/http";
import { loginSchema } from "@/lib/schemas";

const DUMMY_SALT = "00000000000000000000000000000000";
const DUMMY_HASH = "00".repeat(32);

export async function POST(request: NextRequest): Promise<Response> {
  return handle(async () => {
    assertSameOrigin(request);
    const body = await parseJson(request, loginSchema);

    const user = await findUserByIdentifier(body.identifier);
    if (!user) {
      // Keep the failure path roughly as expensive as a real check.
      await verifyPassword(body.password, DUMMY_HASH, DUMMY_SALT, 100_000);
      throw new HttpError(401, "Invalid username or password.");
    }

    const valid = await verifyPassword(
      body.password,
      user.passwordHash,
      user.passwordSalt,
      user.passwordIterations,
    );
    if (!valid) {
      throw new HttpError(401, "Invalid username or password.");
    }

    await upgradePasswordIfNeeded(user, body.password);
    await createSession(user.id);
    await getDb().update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, user.id));

    return json({ user: toPublicUser(user) });
  });
}
