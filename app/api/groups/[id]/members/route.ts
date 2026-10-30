import type { NextRequest } from "next/server";
import { findUserByUsername, requireUser } from "@/lib/auth";
import {
  publishDashboard,
  publishGroupMembers,
  requireGroupConversation,
  requireMembership,
} from "@/lib/chat";
import { getDb } from "@/lib/db";
import { conversationMembers } from "@/lib/db/schema";
import { HttpError, assertSameOrigin, handle, json, parseJson } from "@/lib/http";
import { publishToUsers } from "@/lib/realtime";
import { usernameBodySchema } from "@/lib/schemas";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    assertSameOrigin(request);
    const me = await requireUser();
    const { id } = await params;
    const group = await requireGroupConversation(id);
    const membership = await requireMembership(group.id, me.id);
    if (membership.role !== "admin") {
      throw new HttpError(403, "Only group admins can add members.");
    }

    const body = await parseJson(request, usernameBodySchema);
    const target = await findUserByUsername(body.target_username);
    if (!target) throw new HttpError(404, "No user with that username.");

    await getDb()
      .insert(conversationMembers)
      .values({ conversationId: group.id, userId: target.id, role: "member" })
      .onConflictDoNothing();

    await publishGroupMembers(group.id);
    await publishDashboard([target.id]);
    await publishToUsers([target.id], {
      action: "notification",
      kind: "group_invite",
      title: "Added to a group",
      body: `@${me.username} added you to ${group.name}.`,
      meta: { group_id: group.id, group_name: group.name },
    });

    return json({ ok: true });
  });
}
