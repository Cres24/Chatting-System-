import type { NextRequest } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { HttpError, assertSameOrigin, handle, json } from "@/lib/http";

const MAX_SIZE = 10 * 1024 * 1024;

/**
 * Issues short-lived client tokens so browsers upload straight to Vercel Blob.
 * This keeps large files away from the 4.5 MB serverless request limit.
 */
export async function POST(request: NextRequest): Promise<Response> {
  return handle(async () => {
    assertSameOrigin(request);
    const user = await requireUser();
    const body = (await request.json()) as HandleUploadBody;

    const result = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        const allowedPrefix =
          pathname.startsWith(`media/${user.id}/`) ||
          pathname.startsWith(`avatars/${user.id}/`);
        if (!allowedPrefix) {
          throw new HttpError(403, "Upload path is not allowed.");
        }

        return {
          allowedContentTypes: ["image/*", "audio/*", "video/*"],
          maximumSizeInBytes: MAX_SIZE,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ userId: user.id }),
        };
      },
      onUploadCompleted: async () => {
        // The message/profile row is written by the normal API call afterwards.
      },
    });

    return json(result);
  });
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
