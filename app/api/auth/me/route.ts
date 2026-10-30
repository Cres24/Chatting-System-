import { requireUser, toPublicUser } from "@/lib/auth";
import { handle, json } from "@/lib/http";

export async function GET(): Promise<Response> {
  return handle(async () => {
    const user = await requireUser();
    return json({ user: toPublicUser(user) });
  });
}
