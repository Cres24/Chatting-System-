import { readFile } from "node:fs/promises";
import path from "node:path";
import { get } from "@vercel/blob";
import { env } from "@/lib/env";

function mimeFromExtension(file: string): string {
  const ext = path.extname(file).slice(1).toLowerCase();
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    webm: "audio/webm",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    mp4: "video/mp4",
    mov: "video/quicktime",
    pdf: "application/pdf",
  };
  return map[ext] ?? "application/octet-stream";
}

async function serveLocalUpload(relativeKey: string, fallbackMime: string): Promise<Response> {
  const uploadsRoot = path.resolve(process.cwd(), "public", "uploads");
  const filePath = path.resolve(process.cwd(), "public", relativeKey.replace(/^\/+/, ""));

  if (filePath !== uploadsRoot && !filePath.startsWith(`${uploadsRoot}${path.sep}`)) {
    return new Response("Not found", { status: 404 });
  }

  try {
    const data = await readFile(filePath);
    return new Response(new Uint8Array(data), {
      headers: {
        "content-type": fallbackMime || mimeFromExtension(filePath),
        "content-length": String(data.byteLength),
        "cache-control": "private, max-age=300",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

/**
 * Streams a stored asset without exposing the private Blob URL.
 * Local development uploads (`/uploads/...`) are read from disk instead.
 */
export async function serveStoredAsset(
  storageKey: string,
  fallbackMime = "",
): Promise<Response> {
  if (!storageKey) return new Response("Not found", { status: 404 });

  if (storageKey.startsWith("/uploads/")) {
    return serveLocalUpload(storageKey, fallbackMime || mimeFromExtension(storageKey));
  }

  if (!env.blobToken) {
    return new Response("Not found", { status: 404 });
  }

  try {
    const result = await get(storageKey, {
      access: env.blobAccess,
      token: env.blobToken,
    });

    if (!result || result.statusCode !== 200) {
      return new Response("Not found", { status: 404 });
    }

    return new Response(result.stream, {
      headers: {
        "content-type": result.blob.contentType || fallbackMime,
        "content-length": String(result.blob.size),
        "cache-control": "private, max-age=300",
      },
    });
  } catch (error) {
    console.error("[storage] read failed", error);
    return new Response("Not found", { status: 404 });
  }
}

export function isAllowedUploadMime(mime: string): boolean {
  return (
    mime.startsWith("image/") || mime.startsWith("audio/") || mime.startsWith("video/")
  );
}

/** Accepts only URLs produced by our Blob store or the local dev uploader. */
export function isAllowedUploadUrl(value: string): boolean {
  if (value.startsWith("/uploads/")) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.endsWith(".blob.vercel-storage.com");
  } catch {
    return false;
  }
}
