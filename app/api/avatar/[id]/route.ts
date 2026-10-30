import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { serveStoredAsset } from "@/lib/storage";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return new Response("Not found", { status: 404 });
  }

  try {
    await requireUser();
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  const rows = await getDb()
    .select({ avatarUrl: users.avatarUrl })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);

  if (!rows[0]?.avatarUrl) return new Response("Not found", { status: 404 });
  return serveStoredAsset(rows[0].avatarUrl);
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
