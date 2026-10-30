import { eq } from "drizzle-orm";
import { requireUser } from "@/lib/auth";
import { buildDashboard } from "@/lib/chat";
import { getDb } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { handle, json } from "@/lib/http";

export async function GET(): Promise<Response> {
  return handle(async () => {
    const user = await requireUser();
    await getDb().update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, user.id));
    return json(await buildDashboard(user.id, user));
  });
}
