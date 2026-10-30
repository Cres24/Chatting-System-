import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { groupAvatarUrl } from "@/lib/avatars";
import {
  buildOutgoingMessage,
  getGroupMembers,
  getMemberIds,
  insertMessage,
  loadHistory,
  requireGroupConversation,
  requireMembership,
} from "@/lib/chat";
import { HttpError, assertSameOrigin, handle, json, parseJson } from "@/lib/http";
import { validateIncomingMessage } from "@/lib/message-input";
import { publishToUsers } from "@/lib/realtime";
import { messageSchema } from "@/lib/schemas";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const me = await requireUser();
    const { id } = await params;
    const group = await requireGroupConversation(id);
    await requireMembership(group.id, me.id);

    const beforeParam = request.nextUrl.searchParams.get("before");
    const before = beforeParam && /^\d+$/.test(beforeParam) ? Number(beforeParam) : undefined;
    const page = await loadHistory(group.id, before);

    return json({
      action: "chat_history",
      chat_type: "group",
      target_id: group.id,
      group_name: group.name,
      group_avatar: groupAvatarUrl(group.id, group.avatarUrl),
      members: await getGroupMembers(group.id),
      ...page,
    });
  });
}

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

    const body = await parseJson(request, messageSchema);
    const message = validateIncomingMessage(body);

    const result = await insertMessage({
      conversationId: group.id,
      senderId: me.id,
      kind: message.kind,
      body: message.body,
      attachment: message.attachment,
    });

    const outgoing = buildOutgoingMessage({
      chatType: "group",
      targetId: group.id,
      sender: me,
      kind: message.kind,
      body: message.body,
      attachmentId: result.attachmentId,
      createdAt: result.createdAt,
      groupName: group.name,
      groupAvatar: groupAvatarUrl(group.id, group.avatarUrl),
    });

    const recipients = (await getMemberIds(group.id)).filter((userId) => userId !== me.id);
    await publishToUsers(recipients, outgoing);
    return json({ message: outgoing });
  });
}
