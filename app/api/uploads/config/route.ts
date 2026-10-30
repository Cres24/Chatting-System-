import { requireUser } from "@/lib/auth";
import { env, objectStorageEnabled } from "@/lib/env";
import { handle, json } from "@/lib/http";
import { MAX_UPLOAD_BYTES } from "@/lib/storage";

export async function GET(): Promise<Response> {
  return handle(async () => {
    await requireUser();
    return json({
      mode: objectStorageEnabled() ? "s3" : env.production ? "disabled" : "dev",
      maxSize: MAX_UPLOAD_BYTES,
    });
  });
}

export const dynamic = "force-dynamic";
