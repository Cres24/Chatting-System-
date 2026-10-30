import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { requireMembership } from "@/lib/chat";
import { getDb } from "@/lib/db";
import { attachments, messages } from "@/lib/db/schema";
import { HttpError, handle } from "@/lib/http";
import { serveStoredAsset } from "@/lib/storage";

const idSchema = z.string().uuid();

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!idSchema.safeParse(id).success) {
      return new Response("Not found", { status: 404 });
    }

    const rows = await getDb()
      .select({
        storageKey: attachments.storageKey,
        mimeType: attachments.mimeType,
        conversationId: messages.conversationId,
      })
      .from(attachments)
      .innerJoin(messages, eq(messages.id, attachments.messageId))
      .where(eq(attachments.id, id))
      .limit(1);

    if (!rows[0]) return new Response("Not found", { status: 404 });
    await requireMembership(rows[0].conversationId, user.id);

    return serveStoredAsset(
      rows[0].storageKey,
      rows[0].mimeType,
      request.headers.get("range"),
    );
  } catch (error) {
    if (error instanceof HttpError) {
      return new Response(error.message, { status: error.status });
    }
    console.error("[media]", error);
    return new Response("Not found", { status: 404 });
  }
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
