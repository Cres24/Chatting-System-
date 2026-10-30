import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { findUserByUsername, requireUser } from "@/lib/auth";
import {
  publishGroupMembers,
  requireGroupConversation,
  requireMembership,
} from "@/lib/chat";
import { getDb } from "@/lib/db";
import { conversationMembers } from "@/lib/db/schema";
import { HttpError, assertSameOrigin, handle, json } from "@/lib/http";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; username: string }> },
): Promise<Response> {
  return handle(async () => {
    assertSameOrigin(request);
    const me = await requireUser();
    const { id, username } = await params;
    const group = await requireGroupConversation(id);
    const membership = await requireMembership(group.id, me.id);
    if (membership.role !== "admin") {
      throw new HttpError(403, "Only group admins can promote members.");
    }

    const target = await findUserByUsername(username);
    if (!target) throw new HttpError(404, "No user with that username.");

    await getDb()
      .update(conversationMembers)
      .set({ role: "admin" })
      .where(
        and(
          eq(conversationMembers.conversationId, group.id),
          eq(conversationMembers.userId, target.id),
        ),
      );

    await publishGroupMembers(group.id);
    return json({ ok: true });
  });
}
