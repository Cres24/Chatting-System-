import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { requireUser } from "@/lib/auth";
import { buildDashboard } from "@/lib/chat";
import { getDb } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { assertSameOrigin, handle, json } from "@/lib/http";

/**
 * Cheap liveness ping. The client sends this every 60s; `users.last_seen_at`
 * drives the online dots (90 second window) without a separate presence service.
 */
export async function POST(request: NextRequest): Promise<Response> {
  return handle(async () => {
    assertSameOrigin(request);
    const user = await requireUser();
    await getDb().update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, user.id));
    return json(await buildDashboard(user.id));
  });
}
