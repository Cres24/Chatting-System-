import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { requireMembership } from "@/lib/chat";
import { getDb } from "@/lib/db";
import { conversations } from "@/lib/db/schema";
import { HttpError } from "@/lib/http";
import { serveStoredAsset } from "@/lib/storage";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return new Response("Not found", { status: 404 });
  }

  try {
    const user = await requireUser();
    await requireMembership(id, user.id);

    const rows = await getDb()
      .select({ avatarUrl: conversations.avatarUrl })
      .from(conversations)
      .where(eq(conversations.id, id))
      .limit(1);

    if (!rows[0]?.avatarUrl) return new Response("Not found", { status: 404 });
    return serveStoredAsset(
      rows[0].avatarUrl,
      "",
      request.headers.get("range"),
    );
  } catch (error) {
    if (error instanceof HttpError) {
      return new Response(error.message, { status: error.status });
    }
    return new Response("Not found", { status: 404 });
  }
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
