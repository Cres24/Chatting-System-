import type { NextRequest } from "next/server";
import { findUserByUsername, requireUser } from "@/lib/auth";
import { publishDashboard, removeFriendship } from "@/lib/chat";
import { HttpError, assertSameOrigin, handle, json } from "@/lib/http";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ username: string }> },
): Promise<Response> {
  return handle(async () => {
    assertSameOrigin(request);
    const me = await requireUser();
    const { username } = await params;
    const target = await findUserByUsername(username);
    if (!target) throw new HttpError(404, "No user with that username.");

    await removeFriendship(me.id, target.id);
    await publishDashboard([me.id, target.id]);

    return json({ ok: true });
  });
}
