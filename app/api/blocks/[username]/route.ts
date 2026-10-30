import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { findUserByUsername, requireUser } from "@/lib/auth";
import { publishDashboard } from "@/lib/chat";
import { getDb } from "@/lib/db";
import { blocks } from "@/lib/db/schema";
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

    await getDb()
      .delete(blocks)
      .where(and(eq(blocks.blockerId, me.id), eq(blocks.blockedId, target.id)));

    await publishDashboard([me.id]);
    return json({ ok: true });
  });
}
