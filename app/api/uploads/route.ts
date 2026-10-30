import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { objectStorageEnabled } from "@/lib/env";
import { HttpError, assertSameOrigin, handle, json, parseJson } from "@/lib/http";
import {
  MAX_UPLOAD_BYTES,
  buildStorageKey,
  createPresignedUpload,
  isAllowedUploadMime,
} from "@/lib/storage";

const uploadRequestSchema = z.object({
  scope: z.enum(["media", "avatars"]),
  content_type: z.string().min(1).max(120),
  size: z.number().int().nonnegative().max(MAX_UPLOAD_BYTES),
});

/**
 * Issues a short-lived presigned S3 PUT URL so browsers upload straight to
 * Neon Object Storage instead of through the serverless request body limit.
 */
export async function POST(request: NextRequest): Promise<Response> {
  return handle(async () => {
    assertSameOrigin(request);
    const user = await requireUser();
    if (!objectStorageEnabled()) {
      throw new HttpError(503, "Object storage is not configured.");
    }

    const body = await parseJson(request, uploadRequestSchema);
    if (!isAllowedUploadMime(body.content_type)) {
      throw new HttpError(400, "Only images, audio, and video are supported.");
    }
    if (body.size === 0) {
      throw new HttpError(400, "The file is empty.");
    }

    const key = buildStorageKey(body.scope, user.id, body.content_type);
    const { uploadUrl, headers } = await createPresignedUpload(
      key,
      body.content_type,
    );

    return json({
      key,
      uploadUrl,
      headers,
      mime_type: body.content_type,
      size: body.size,
    });
  });
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
