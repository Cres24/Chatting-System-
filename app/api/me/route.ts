import type { NextRequest } from "next/server";
import { and, eq, ne, or, sql } from "drizzle-orm";
import {
  hashPassword,
  requireUser,
  toPublicUser,
  verifyPassword,
} from "@/lib/auth";
import { getGroupMembers, getMemberIds, publishDashboard } from "@/lib/chat";
import { getDb } from "@/lib/db";
import { conversationMembers, conversations, friendships, users } from "@/lib/db/schema";
import { HttpError, assertSameOrigin, handle, json, parseJson } from "@/lib/http";
import { isAllowedStorageKey, requireStoredObject } from "@/lib/storage";
import { profileSchema } from "@/lib/schemas";
import { publishToUsers } from "@/lib/realtime";

export async function PATCH(request: NextRequest): Promise<Response> {
  return handle(async () => {
    assertSameOrigin(request);
    const user = await requireUser();
    const body = await parseJson(request, profileSchema);

    const valid = await verifyPassword(
      body.current_password,
      user.passwordHash,
      user.passwordSalt,
      user.passwordIterations,
    );
    if (!valid) throw new HttpError(400, "Current password is incorrect.");

    if (body.new_password) {
      if (body.new_password.length < 6) {
        throw new HttpError(400, "New password must be at least 6 characters.");
      }
    }

    const db = getDb();
    const conflict = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          ne(users.id, user.id),
          or(
            sql`lower(${users.username}) = lower(${body.new_username})`,
            sql`lower(${users.email}) = lower(${body.new_email})`,
          ),
        ),
      )
      .limit(1);

    if (conflict[0]) {
      throw new HttpError(400, "That username or email is already in use.");
    }

    const updates: Partial<typeof users.$inferInsert> = {
      fullName: body.new_fullname,
      username: body.new_username,
      email: body.new_email.toLowerCase(),
    };

    if (body.avatar && body.avatar.startsWith("data:")) {
      throw new HttpError(400, "Upload the avatar before saving the profile.");
    }
    if (body.avatar === "") {
      updates.avatarUrl = "";
    } else if (body.avatar.startsWith("/api/avatar/")) {
      // `/api/avatar/...` means "unchanged" (it is the proxy URL we returned).
    } else if (
      body.avatar.startsWith("/uploads/") ||
      isAllowedStorageKey(body.avatar, "avatars", user.id)
    ) {
      await requireStoredObject(body.avatar, {
        scope: "avatars",
        ownerId: user.id,
      });
      updates.avatarUrl = body.avatar;
    } else {
      throw new HttpError(400, "Invalid avatar key.");
    }

    if (body.new_password) {
      const password = await hashPassword(body.new_password);
      updates.passwordHash = password.hash;
      updates.passwordSalt = password.salt;
      updates.passwordIterations = password.iterations;
    }

    const [updated] = await db
      .update(users)
      .set(updates)
      .where(eq(users.id, user.id))
      .returning();

    const friendRows = await db
      .select({ friendId: friendships.friendId })
      .from(friendships)
      .where(eq(friendships.userId, user.id));

    await publishDashboard([user.id, ...friendRows.map((row) => row.friendId)]);

    // Group member lists embed the display name and avatar, so refresh them too.
    const groupRows = await db
      .select({ id: conversations.id })
      .from(conversations)
      .innerJoin(conversationMembers, eq(conversationMembers.conversationId, conversations.id))
      .where(and(eq(conversationMembers.userId, user.id), eq(conversations.type, "group")));

    for (const group of groupRows) {
      const memberIds = await getMemberIds(group.id);
      await publishToUsers(memberIds, {
        action: "group_members_updated",
        group_id: group.id,
        members: await getGroupMembers(group.id),
      });
    }

    return json({ user: toPublicUser(updated) });
  });
}
