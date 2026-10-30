import type { NextRequest } from "next/server";
import { and, eq, or } from "drizzle-orm";
import { findUserByUsername, requireUser } from "@/lib/auth";
import { isBlockedPair, publishDashboard } from "@/lib/chat";
import { getDb } from "@/lib/db";
import { blocks, friendRequests, friendships } from "@/lib/db/schema";
import { HttpError, assertSameOrigin, handle, json, parseJson } from "@/lib/http";
import { usernameBodySchema } from "@/lib/schemas";

export async function POST(request: NextRequest): Promise<Response> {
  return handle(async () => {
    assertSameOrigin(request);
    const me = await requireUser();
    const body = await parseJson(request, usernameBodySchema);

    const target = await findUserByUsername(body.target_username);
    if (!target) throw new HttpError(404, "No user with that username.");
    if (target.id === me.id) throw new HttpError(400, "You cannot block yourself.");
    if (await isBlockedPair(me.id, target.id)) {
      return json({ ok: true });
    }

    const db = getDb();
    await db
      .delete(friendships)
      .where(
        or(
          and(eq(friendships.userId, me.id), eq(friendships.friendId, target.id)),
          and(eq(friendships.userId, target.id), eq(friendships.friendId, me.id)),
        ),
      );
    await db
      .delete(friendRequests)
      .where(
        or(
          and(eq(friendRequests.fromUser, me.id), eq(friendRequests.toUser, target.id)),
          and(eq(friendRequests.fromUser, target.id), eq(friendRequests.toUser, me.id)),
        ),
      );
    await db
      .insert(blocks)
      .values({ blockerId: me.id, blockedId: target.id })
      .onConflictDoNothing();

    await publishDashboard([me.id, target.id]);
    return json({ ok: true });
  });
}
