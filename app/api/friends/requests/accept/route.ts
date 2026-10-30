import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { findUserByUsername, requireUser } from "@/lib/auth";
import { addFriendship, publishDashboard } from "@/lib/chat";
import { getDb } from "@/lib/db";
import { friendRequests } from "@/lib/db/schema";
import { HttpError, assertSameOrigin, handle, json, parseJson } from "@/lib/http";
import { publishToUsers } from "@/lib/realtime";
import { acceptRequestSchema } from "@/lib/schemas";

export async function POST(request: NextRequest): Promise<Response> {
  return handle(async () => {
    assertSameOrigin(request);
    const me = await requireUser();
    const body = await parseJson(request, acceptRequestSchema);

    const from = await findUserByUsername(body.from_user);
    if (!from) throw new HttpError(404, "No user with that username.");

    const db = getDb();
    const pending = await db
      .select({ id: friendRequests.id })
      .from(friendRequests)
      .where(
        and(
          eq(friendRequests.fromUser, from.id),
          eq(friendRequests.toUser, me.id),
          eq(friendRequests.status, "pending"),
        ),
      )
      .limit(1);

    if (!pending[0]) throw new HttpError(404, "No pending request from that user.");

    await addFriendship(me.id, from.id);
    await db
      .update(friendRequests)
      .set({ status: "accepted", respondedAt: new Date() })
      .where(eq(friendRequests.id, pending[0].id));

    await publishToUsers([from.id], {
      action: "notification",
      kind: "friend_accepted",
      title: "Friend request accepted",
      body: `@${me.username} accepted your request.`,
      meta: { from_user: me.username },
    });
    await publishDashboard([me.id, from.id]);

    return json({ ok: true });
  });
}
