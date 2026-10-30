import { and, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  attachments,
  blocks,
  conversationMembers,
  conversations,
  friendRequests,
  friendships,
  messages,
  users,
} from "@/lib/db/schema";
import { toPublicUser, type DbUser } from "@/lib/auth";
import { groupAvatarUrl, userAvatarUrl } from "@/lib/avatars";
import { isOnline } from "@/lib/presence";
import { publishToUsers } from "@/lib/realtime";
import { HttpError } from "@/lib/http";

export type FriendJson = {
  username: string;
  full_name: string;
  avatar: string;
  online: boolean;
};

export type GroupJson = {
  id: string;
  name: string;
  avatar: string;
};

export type GroupMemberJson = {
  username: string;
  full_name: string;
  avatar: string;
  role: string;
  online: boolean;
};

export type LegacyMessageJson = {
  sender: string;
  sender_name: string;
  text: string;
  msg_type: string;
  avatar: string;
};

export type MessageKind = "text" | "image" | "audio" | "video" | "file" | "system";

export const MESSAGE_KINDS: readonly MessageKind[] = [
  "text",
  "image",
  "audio",
  "video",
  "file",
  "system",
];

export function isMessageKind(value: string): value is MessageKind {
  return (MESSAGE_KINDS as readonly string[]).includes(value);
}

export async function listFriends(userId: string): Promise<FriendJson[]> {
  const rows = await getDb()
    .select({
      id: users.id,
      username: users.username,
      fullName: users.fullName,
      avatar: users.avatarUrl,
      lastSeenAt: users.lastSeenAt,
    })
    .from(friendships)
    .innerJoin(users, eq(users.id, friendships.friendId))
    .where(eq(friendships.userId, userId))
    .orderBy(users.fullName);

  return rows.map((row) => ({
    username: row.username,
    full_name: row.fullName,
    avatar: userAvatarUrl(row.id, row.avatar),
    online: isOnline(row.lastSeenAt),
  }));
}

export async function listPendingRequests(userId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ username: users.username })
    .from(friendRequests)
    .innerJoin(users, eq(users.id, friendRequests.fromUser))
    .where(and(eq(friendRequests.toUser, userId), eq(friendRequests.status, "pending")))
    .orderBy(friendRequests.createdAt);

  return rows.map((row) => row.username);
}

export async function listGroups(userId: string): Promise<GroupJson[]> {
  const rows = await getDb()
    .select({
      id: conversations.id,
      name: conversations.name,
      avatar: conversations.avatarUrl,
    })
    .from(conversations)
    .innerJoin(conversationMembers, eq(conversationMembers.conversationId, conversations.id))
    .where(and(eq(conversationMembers.userId, userId), eq(conversations.type, "group")))
    .orderBy(conversations.name);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    avatar: groupAvatarUrl(row.id, row.avatar),
  }));
}

export async function listBlocked(userId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ username: users.username })
    .from(blocks)
    .innerJoin(users, eq(users.id, blocks.blockedId))
    .where(eq(blocks.blockerId, userId))
    .orderBy(users.username);

  return rows.map((row) => row.username);
}

export async function areFriends(a: string, b: string): Promise<boolean> {
  const rows = await getDb()
    .select({ userId: friendships.userId })
    .from(friendships)
    .where(and(eq(friendships.userId, a), eq(friendships.friendId, b)))
    .limit(1);
  return rows.length > 0;
}

export async function isBlockedPair(a: string, b: string): Promise<boolean> {
  const rows = await getDb()
    .select({ blockerId: blocks.blockerId })
    .from(blocks)
    .where(
      or(
        and(eq(blocks.blockerId, a), eq(blocks.blockedId, b)),
        and(eq(blocks.blockerId, b), eq(blocks.blockedId, a)),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function addFriendship(a: string, b: string): Promise<void> {
  const db = getDb();
  await db
    .insert(friendships)
    .values([
      { userId: a, friendId: b },
      { userId: b, friendId: a },
    ])
    .onConflictDoNothing();
}

export async function removeFriendship(a: string, b: string): Promise<void> {
  const db = getDb();
  await db
    .delete(friendships)
    .where(
      or(
        and(eq(friendships.userId, a), eq(friendships.friendId, b)),
        and(eq(friendships.userId, b), eq(friendships.friendId, a)),
      ),
    );
}

export function directKey(a: string, b: string): string {
  return [a, b].sort().join(":");
}

export async function findDirectConversation(a: string, b: string): Promise<string | null> {
  const rows = await getDb()
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.type, "direct"),
        eq(conversations.directKey, directKey(a, b)),
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

export async function ensureDirectConversation(a: string, b: string): Promise<string> {
  const existing = await findDirectConversation(a, b);
  if (existing) return existing;
  const db = getDb();
  const key = directKey(a, b);

  try {
    return await db.transaction(async (tx) => {
      const [conversation] = await tx
        .insert(conversations)
        .values({ type: "direct", createdBy: a, directKey: key })
        .returning({ id: conversations.id });

      await tx.insert(conversationMembers).values([
        { conversationId: conversation.id, userId: a, role: "member" },
        { conversationId: conversation.id, userId: b, role: "member" },
      ]);

      return conversation.id;
    });
  } catch (error) {
    // Two first messages racing: fall back to the row the other request created.
    const again = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.type, "direct"), eq(conversations.directKey, key)))
      .limit(1);
    if (again[0]) return again[0].id;
    throw error;
  }
}

export async function requireMembership(
  conversationId: string,
  userId: string,
): Promise<{ role: string }> {
  const rows = await getDb()
    .select({ role: conversationMembers.role })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, userId),
      ),
    )
    .limit(1);

  if (!rows[0]) throw new HttpError(403, "You are not a member of this conversation.");
  return rows[0];
}

export async function getConversation(conversationId: string) {
  const rows = await getDb()
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  return rows[0] ?? null;
}

export async function requireGroupConversation(conversationId: string) {
  const conversation = await getConversation(conversationId);
  if (!conversation || conversation.type !== "group") {
    throw new HttpError(404, "Group not found.");
  }
  return conversation;
}

export async function publishGroupMembers(conversationId: string): Promise<void> {
  const [memberIds, members] = await Promise.all([
    getMemberIds(conversationId),
    getGroupMembers(conversationId),
  ]);
  await publishToUsers(memberIds, {
    action: "group_members_updated",
    group_id: conversationId,
    members,
  });
}

export async function getMemberIds(conversationId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ userId: conversationMembers.userId })
    .from(conversationMembers)
    .where(eq(conversationMembers.conversationId, conversationId));
  return rows.map((row) => row.userId);
}

export async function getMemberUsernames(conversationId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ username: users.username })
    .from(conversationMembers)
    .innerJoin(users, eq(users.id, conversationMembers.userId))
    .where(eq(conversationMembers.conversationId, conversationId));
  return rows.map((row) => row.username);
}

export async function getGroupMembers(conversationId: string): Promise<GroupMemberJson[]> {
  const rows = await getDb()
    .select({
      userId: users.id,
      username: users.username,
      fullName: users.fullName,
      avatar: users.avatarUrl,
      role: conversationMembers.role,
      lastSeenAt: users.lastSeenAt,
    })
    .from(conversationMembers)
    .innerJoin(users, eq(users.id, conversationMembers.userId))
    .where(eq(conversationMembers.conversationId, conversationId));

  return rows.map((row) => ({
    username: row.username,
    full_name: row.fullName,
    avatar: userAvatarUrl(row.userId, row.avatar),
    role: row.role,
    online: isOnline(row.lastSeenAt),
  }));
}

export async function buildDashboard(userId: string, user?: DbUser) {
  const [friends, requests, groups, blocked] = await Promise.all([
    listFriends(userId),
    listPendingRequests(userId),
    listGroups(userId),
    listBlocked(userId),
  ]);

  return {
    action: "dashboard_sync" as const,
    user: user ? toPublicUser(user) : undefined,
    friends,
    requests,
    groups,
    blocked,
  };
}

export async function publishDashboard(userIds: string[]): Promise<void> {
  await Promise.all(
    userIds.map(async (userId) => {
      const payload = await buildDashboard(userId);
      await publishToUsers([userId], payload);
    }),
  );
}

export async function loadHistory(
  conversationId: string,
  before?: number,
  limit = 50,
): Promise<{ history: LegacyMessageJson[]; nextBefore: number | null; hasMore: boolean }> {
  const rows = await getDb()
    .select({
      id: messages.id,
      kind: messages.kind,
      body: messages.body,
      senderId: users.id,
      sender: users.username,
      senderName: users.fullName,
      avatar: users.avatarUrl,
      attachmentId: attachments.id,
    })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.senderId))
    .leftJoin(attachments, eq(attachments.messageId, messages.id))
    .where(
      and(
        eq(messages.conversationId, conversationId),
        isNull(messages.deletedAt),
        before ? lt(messages.id, before) : undefined,
      ),
    )
    .orderBy(desc(messages.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextBefore = hasMore ? page[page.length - 1].id : null;

  const history = page.reverse().map((row) => ({
    sender: row.sender ?? "deleted",
    sender_name: row.senderName ?? "Deleted user",
    text: row.kind === "text" ? row.body : row.attachmentId ? `/api/media/${row.attachmentId}` : row.body,
    msg_type: row.kind,
    avatar: row.senderId ? userAvatarUrl(row.senderId, row.avatar) : "",
  }));

  return { history, nextBefore, hasMore };
}

export type InsertMessageInput = {
  conversationId: string;
  senderId: string;
  kind: MessageKind;
  body: string;
  attachment?: {
    storageKey: string;
    mimeType: string;
    sizeBytes: number;
  };
};

export async function insertMessage(input: InsertMessageInput): Promise<{
  messageId: number;
  attachmentId: string | null;
  createdAt: Date;
}> {
  const db = getDb();

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(messages)
      .values({
        conversationId: input.conversationId,
        senderId: input.senderId,
        kind: input.kind,
        body: input.attachment ? "" : input.body,
      })
      .returning({ id: messages.id, createdAt: messages.createdAt });

    let attachmentId: string | null = null;
    if (input.attachment) {
      const [attachment] = await tx
        .insert(attachments)
        .values({
          messageId: row.id,
          storageKey: input.attachment.storageKey,
          mimeType: input.attachment.mimeType,
          sizeBytes: input.attachment.sizeBytes,
        })
        .returning({ id: attachments.id });
      attachmentId = attachment.id;
    }

    await tx
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, input.conversationId));

    return { messageId: row.id, attachmentId, createdAt: row.createdAt };
  });
}

export type OutgoingMessage = {
  action: "new_message";
  chat_type: "direct" | "group";
  target_id: string;
  sender: string;
  sender_name: string;
  text: string;
  msg_type: string;
  avatar: string;
  group_name?: string;
  group_avatar?: string;
  created_at: string;
};

export function buildOutgoingMessage(options: {
  chatType: "direct" | "group";
  targetId: string;
  sender: DbUser;
  kind: MessageKind;
  body: string;
  attachmentId: string | null;
  createdAt: Date;
  groupName?: string;
  groupAvatar?: string;
}): OutgoingMessage {
  return {
    action: "new_message",
    chat_type: options.chatType,
    target_id: options.targetId,
    sender: options.sender.username,
    sender_name: options.sender.fullName || options.sender.username,
    text:
      options.kind === "text"
        ? options.body
        : options.attachmentId
          ? `/api/media/${options.attachmentId}`
          : options.body,
    msg_type: options.kind,
    avatar: userAvatarUrl(options.sender.id, options.sender.avatarUrl),
    created_at: options.createdAt.toISOString(),
    ...(options.groupName !== undefined ? { group_name: options.groupName } : {}),
    ...(options.groupAvatar !== undefined ? { group_avatar: options.groupAvatar } : {}),
  };
}

export async function getUsernamesByIds(ids: string[]): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  const rows = await getDb()
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(inArray(users.id, ids));
  return Object.fromEntries(rows.map((row) => [row.id, row.username]));
}
