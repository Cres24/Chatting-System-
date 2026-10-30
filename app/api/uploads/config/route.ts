import { requireUser } from "@/lib/auth";
import { blobEnabled, env } from "@/lib/env";
import { handle, json } from "@/lib/http";

export async function GET(): Promise<Response> {
  return handle(async () => {
    const user = await requireUser();
    const mode = blobEnabled() ? "blob" : env.production ? "disabled" : "dev";
    return json({
      mode,
      access: env.blobAccess,
      userId: user.id,
      maxSize: 10 * 1024 * 1024,
    });
  });
}

export const dynamic = "force-dynamic";
