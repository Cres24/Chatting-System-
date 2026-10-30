import type { NextRequest } from "next/server";
import { findUserByUsername, requireUser } from "@/lib/auth";
import {
  buildOutgoingMessage,
  findDirectConversation,
  insertMessage,
  isBlockedPair,
  loadHistory,
  ensureDirectConversation,
} from "@/lib/chat";
import { HttpError, assertSameOrigin, handle, json, parseJson } from "@/lib/http";
import { validateIncomingMessage } from "@/lib/message-input";
import { publishToUsers } from "@/lib/realtime";
import { messageSchema } from "@/lib/schemas";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ username: string }> },
): Promise<Response> {
  return handle(async () => {
    const me = await requireUser();
    const { username } = await params;
    const target = await findUserByUsername(username);
    if (!target) throw new HttpError(404, "No user with that username.");
    if (await isBlockedPair(me.id, target.id)) {
      throw new HttpError(403, "This conversation is blocked.");
    }

    const conversationId = await findDirectConversation(me.id, target.id);
    if (!conversationId) {
      return json({
        action: "chat_history",
        chat_type: "direct",
        target_id: target.username,
        history: [],
        hasMore: false,
        nextBefore: null,
      });
    }

    const beforeParam = request.nextUrl.searchParams.get("before");
    const before = beforeParam && /^\d+$/.test(beforeParam) ? Number(beforeParam) : undefined;
    const page = await loadHistory(conversationId, before);

    return json({
      action: "chat_history",
      chat_type: "direct",
      target_id: target.username,
      ...page,
    });
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ username: string }> },
): Promise<Response> {
  return handle(async () => {
    assertSameOrigin(request);
    const me = await requireUser();
    const { username } = await params;
    const target = await findUserByUsername(username);
    if (!target) throw new HttpError(404, "No user with that username.");
    if (target.id === me.id) throw new HttpError(400, "You cannot message yourself.");
    if (await isBlockedPair(me.id, target.id)) {
      throw new HttpError(403, "This conversation is blocked.");
    }

    const body = await parseJson(request, messageSchema);
    const message = await validateIncomingMessage(body, me.id);
    const conversationId = await ensureDirectConversation(me.id, target.id);

    const result = await insertMessage({
      conversationId,
      senderId: me.id,
      kind: message.kind,
      body: message.body,
      attachment: message.attachment,
    });

    const outgoing = buildOutgoingMessage({
      chatType: "direct",
      targetId: target.username,
      sender: me,
      kind: message.kind,
      body: message.body,
      attachmentId: result.attachmentId,
      createdAt: result.createdAt,
    });

    await publishToUsers([target.id], outgoing);
    return json({ message: outgoing });
  });
}
