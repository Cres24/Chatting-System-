import type { NextRequest } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { requireUser } from "@/lib/auth";
import {
  getMemberIds,
  publishDashboard,
  publishGroupMembers,
  requireGroupConversation,
  requireMembership,
} from "@/lib/chat";
import { getDb } from "@/lib/db";
import { conversationMembers, conversations } from "@/lib/db/schema";
import { assertSameOrigin, handle, json } from "@/lib/http";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    assertSameOrigin(request);
    const me = await requireUser();
    const { id } = await params;
    const group = await requireGroupConversation(id);
    await requireMembership(group.id, me.id);

    const db = getDb();
    await db
      .delete(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, group.id),
          eq(conversationMembers.userId, me.id),
        ),
      );

    const remaining = await getMemberIds(group.id);
    if (remaining.length === 0) {
      await db.delete(conversations).where(eq(conversations.id, group.id));
      await publishDashboard([me.id]);
      return json({ ok: true });
    }

    const admins = await db
      .select({ userId: conversationMembers.userId })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, group.id),
          eq(conversationMembers.role, "admin"),
        ),
      );

    if (admins.length === 0) {
      const [oldest] = await db
        .select({ userId: conversationMembers.userId })
        .from(conversationMembers)
        .where(eq(conversationMembers.conversationId, group.id))
        .orderBy(asc(conversationMembers.joinedAt))
        .limit(1);
      if (oldest) {
        await db
          .update(conversationMembers)
          .set({ role: "admin" })
          .where(
            and(
              eq(conversationMembers.conversationId, group.id),
              eq(conversationMembers.userId, oldest.userId),
            ),
          );
      }
    }

    await publishGroupMembers(group.id);
    await publishDashboard([me.id, ...remaining]);
    return json({ ok: true });
  });
}
