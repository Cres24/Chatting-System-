import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { findUserByUsername, requireUser } from "@/lib/auth";
import { areFriends, isBlockedPair, publishDashboard } from "@/lib/chat";
import { getDb } from "@/lib/db";
import { friendRequests } from "@/lib/db/schema";
import { HttpError, assertSameOrigin, handle, json, parseJson } from "@/lib/http";
import { publishToUsers } from "@/lib/realtime";
import { friendRequestSchema } from "@/lib/schemas";

export async function POST(request: NextRequest): Promise<Response> {
  return handle(async () => {
    assertSameOrigin(request);
    const me = await requireUser();
    const body = await parseJson(request, friendRequestSchema);

    const target = await findUserByUsername(body.to_user);
    if (!target) throw new HttpError(404, "No user with that username.");
    if (target.id === me.id) throw new HttpError(400, "You cannot add yourself.");
    if (await isBlockedPair(me.id, target.id)) {
      throw new HttpError(400, "You cannot send a request to this user.");
    }
    if (await areFriends(me.id, target.id)) {
      throw new HttpError(400, "You are already friends.");
    }

    const db = getDb();
    const pending = await db
      .select({ id: friendRequests.id })
      .from(friendRequests)
      .where(
        and(
          eq(friendRequests.fromUser, target.id),
          eq(friendRequests.toUser, me.id),
          eq(friendRequests.status, "pending"),
        ),
      )
      .limit(1);

    if (pending[0]) {
      throw new HttpError(400, "They already sent you a request. Accept it instead.");
    }

    try {
      await db.insert(friendRequests).values({ fromUser: me.id, toUser: target.id });
    } catch {
      throw new HttpError(400, "A request is already pending.");
    }

    await publishToUsers([target.id], {
      action: "notification",
      kind: "friend_request",
      title: "New friend request",
      body: `@${me.username} wants to connect.`,
      meta: { from_user: me.username },
    });
    await publishDashboard([me.id, target.id]);

    return json({ ok: true });
  });
}
