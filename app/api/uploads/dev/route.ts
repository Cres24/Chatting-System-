import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { blobEnabled, env } from "@/lib/env";
import { HttpError, assertSameOrigin, handle, json } from "@/lib/http";
import { isAllowedUploadMime } from "@/lib/storage";

const MAX_SIZE = 10 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "audio/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "video/webm": "webm",
  "video/mp4": "mp4",
};

/**
 * Local-development fallback when no Blob store is connected. Files are written
 * to public/uploads (gitignored) and never used in production.
 */
export async function POST(request: NextRequest): Promise<Response> {
  return handle(async () => {
    assertSameOrigin(request);
    if (blobEnabled() || env.production) {
      throw new HttpError(404, "Local uploads are disabled.");
    }
    await requireUser();

    const form = await request.formData();
    const file = form.get("file");

    if (!file || typeof file === "string") {
      throw new HttpError(400, "No file provided.");
    }
    if (file.size > MAX_SIZE) {
      throw new HttpError(400, "File size exceeds the 10 MB limit.");
    }
    if (!isAllowedUploadMime(file.type)) {
      throw new HttpError(400, "Only images, audio, and video are supported.");
    }

    const extension = EXTENSIONS[file.type] ?? "bin";
    const name = `${randomUUID()}.${extension}`;
    const uploadsDir = path.join(process.cwd(), "public", "uploads");
    await mkdir(uploadsDir, { recursive: true });
    await writeFile(
      path.join(uploadsDir, name),
      new Uint8Array(await file.arrayBuffer()),
    );

    return json({
      url: `/uploads/${name}`,
      mimeType: file.type,
      size: file.size,
    });
  });
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
