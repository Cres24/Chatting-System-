import type { NextRequest } from "next/server";
import { findUserByUsername, requireUser } from "@/lib/auth";
import { groupAvatarUrl } from "@/lib/avatars";
import { publishDashboard } from "@/lib/chat";
import { getDb } from "@/lib/db";
import { conversationMembers, conversations } from "@/lib/db/schema";
import { HttpError, assertSameOrigin, handle, json, parseJson } from "@/lib/http";
import { publishToUsers } from "@/lib/realtime";
import { createGroupSchema } from "@/lib/schemas";
import { isAllowedStorageKey, requireStoredObject } from "@/lib/storage";

export async function POST(request: NextRequest): Promise<Response> {
  return handle(async () => {
    assertSameOrigin(request);
    const me = await requireUser();
    const body = await parseJson(request, createGroupSchema);

    let avatar = "";
    if (body.avatar) {
      if (
        !body.avatar.startsWith("/uploads/") &&
        !isAllowedStorageKey(body.avatar, "avatars", me.id)
      ) {
        throw new HttpError(400, "Invalid group avatar key.");
      }
      await requireStoredObject(body.avatar, {
        scope: "avatars",
        ownerId: me.id,
      });
      avatar = body.avatar;
    }

    const invitees = [] as { id: string; username: string }[];
    const seen = new Set<string>([me.id]);
    for (const username of body.members) {
      const user = await findUserByUsername(username);
      if (!user || seen.has(user.id)) continue;
      seen.add(user.id);
      invitees.push({ id: user.id, username: user.username });
    }

    const db = getDb();
    const created = await db.transaction(async (tx) => {
      const [conversation] = await tx
        .insert(conversations)
        .values({
          type: "group",
          name: body.name,
          avatarUrl: avatar,
          createdBy: me.id,
        })
        .returning();

      await tx.insert(conversationMembers).values([
        { conversationId: conversation.id, userId: me.id, role: "admin" as const },
        ...invitees.map((invitee) => ({
          conversationId: conversation.id,
          userId: invitee.id,
          role: "member" as const,
        })),
      ]);

      return conversation;
    });

    await publishDashboard([me.id, ...invitees.map((invitee) => invitee.id)]);
    await publishToUsers(
      invitees.map((invitee) => invitee.id),
      {
        action: "notification",
        kind: "group_invite",
        title: "Added to a group",
        body: `@${me.username} added you to ${body.name}.`,
        meta: { group_id: created.id, group_name: body.name },
      },
    );

    return json({
      group: {
        id: created.id,
        name: created.name,
        avatar: groupAvatarUrl(created.id, created.avatarUrl),
      },
    });
  });
}
