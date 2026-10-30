import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { env, objectStorageEnabled } from "@/lib/env";
import { HttpError, assertSameOrigin, handle, json } from "@/lib/http";
import {
  MAX_UPLOAD_BYTES,
  extensionForMime,
  isAllowedUploadMime,
} from "@/lib/storage";

/**
 * Local-development fallback when Neon object storage is not configured. Files
 * are written to public/uploads (gitignored) and never used in production.
 */
export async function POST(request: NextRequest): Promise<Response> {
  return handle(async () => {
    assertSameOrigin(request);
    if (objectStorageEnabled() || env.production) {
      throw new HttpError(404, "Local uploads are disabled.");
    }
    await requireUser();

    const form = await request.formData();
    const file = form.get("file");

    if (!file || typeof file === "string") {
      throw new HttpError(400, "No file provided.");
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new HttpError(400, "File size exceeds the 10 MB limit.");
    }
    if (file.size === 0) {
      throw new HttpError(400, "The file is empty.");
    }
    if (!isAllowedUploadMime(file.type)) {
      throw new HttpError(400, "Only images, audio, and video are supported.");
    }

    const name = `${randomUUID()}.${extensionForMime(file.type)}`;
    const uploadsDir = path.join(process.cwd(), "public", "uploads");
    await mkdir(uploadsDir, { recursive: true });
    await writeFile(
      path.join(uploadsDir, name),
      new Uint8Array(await file.arrayBuffer()),
    );

    return json({
      key: `/uploads/${name}`,
      mimeType: file.type,
      size: file.size,
    });
  });
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
