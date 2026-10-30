import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { requireUser } from "@/lib/auth";
import { groupAvatarUrl } from "@/lib/avatars";
import {
  getMemberIds,
  publishDashboard,
  requireGroupConversation,
  requireMembership,
} from "@/lib/chat";
import { getDb } from "@/lib/db";
import { conversations } from "@/lib/db/schema";
import { HttpError, assertSameOrigin, handle, json, parseJson } from "@/lib/http";
import { publishToUsers } from "@/lib/realtime";
import { updateGroupSchema } from "@/lib/schemas";
import { isAllowedStorageKey, requireStoredObject } from "@/lib/storage";

export async function PATCH(
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
      throw new HttpError(403, "Only group admins can edit the group.");
    }

    const body = await parseJson(request, updateGroupSchema);
    const updates: Partial<typeof conversations.$inferInsert> = { updatedAt: new Date() };

    if (body.name !== undefined) updates.name = body.name;

    if (body.avatar !== undefined) {
      if (body.avatar === "") {
        updates.avatarUrl = "";
      } else if (body.avatar.startsWith("/api/group-avatar/")) {
        // Unchanged proxy URL.
      } else if (
        body.avatar.startsWith("/uploads/") ||
        isAllowedStorageKey(body.avatar, "avatars", me.id)
      ) {
        await requireStoredObject(body.avatar, {
          scope: "avatars",
          ownerId: me.id,
        });
        updates.avatarUrl = body.avatar;
      } else {
        throw new HttpError(400, "Invalid group avatar key.");
      }
    }

    const [updated] = await getDb()
      .update(conversations)
      .set(updates)
      .where(eq(conversations.id, group.id))
      .returning();

    const avatar = groupAvatarUrl(updated.id, updated.avatarUrl);
    const memberIds = await getMemberIds(group.id);

    await publishToUsers(memberIds, {
      action: "group_info_updated",
      group_id: group.id,
      name: updated.name,
      avatar,
    });
    await publishDashboard(memberIds);

    return json({
      group: { id: updated.id, name: updated.name, avatar },
    });
  });
}
