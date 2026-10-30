import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env, objectStorageEnabled } from "@/lib/env";
import { HttpError } from "@/lib/http";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const PRESIGNED_UPLOAD_TTL_SECONDS = 10 * 60;

export type UploadScope = "media" | "avatars";

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
  "video/quicktime": "mov",
};

const globalForS3 = globalThis as unknown as {
  chatS3?: S3Client;
};

function s3Client(): S3Client {
  if (!objectStorageEnabled()) {
    throw new Error("Neon object storage is not configured.");
  }
  if (!globalForS3.chatS3) {
    globalForS3.chatS3 = new S3Client({
      // Neon Object Storage requires path-style addressing and SigV4.
      forcePathStyle: true,
      region: env.s3Region,
      endpoint: env.s3Endpoint,
      credentials: {
        accessKeyId: env.s3AccessKeyId,
        secretAccessKey: env.s3SecretAccessKey,
      },
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  return globalForS3.chatS3;
}

export function extensionForMime(mimeType: string): string {
  return EXTENSIONS[mimeType] ?? "bin";
}

export function buildStorageKey(
  scope: UploadScope,
  ownerId: string,
  mimeType: string,
): string {
  return `${scope}/${ownerId}/${randomUUID()}.${extensionForMime(mimeType)}`;
}

export function isAllowedUploadMime(mime: string): boolean {
  return (
    mime.startsWith("image/") || mime.startsWith("audio/") || mime.startsWith("video/")
  );
}

/** Accepts an S3 key owned by the caller, or a local development upload. */
export function isAllowedStorageKey(
  value: string,
  scope: UploadScope,
  ownerId: string,
): boolean {
  if (value.startsWith("/uploads/")) {
    return /^\/uploads\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
  }

  const escapedOwner = ownerId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${scope}/${escapedOwner}/[A-Za-z0-9][A-Za-z0-9._-]*$`).test(
    value,
  );
}

export async function createPresignedUpload(
  key: string,
  mimeType: string,
): Promise<{ uploadUrl: string; headers: Record<string, string> }> {
  const command = new PutObjectCommand({
    Bucket: env.s3Bucket,
    Key: key,
    ContentType: mimeType,
  });
  const uploadUrl = await getSignedUrl(s3Client(), command, {
    expiresIn: PRESIGNED_UPLOAD_TTL_SECONDS,
  });
  return { uploadUrl, headers: { "content-type": mimeType } };
}

export async function headStoredObject(
  storageKey: string,
): Promise<{ contentType: string; contentLength: number } | null> {
  if (!objectStorageEnabled()) return null;

  try {
    const result = await s3Client().send(
      new HeadObjectCommand({
        Bucket: env.s3Bucket,
        Key: storageKey,
      }),
    );
    return {
      contentType: result.ContentType ?? "",
      contentLength: result.ContentLength ?? 0,
    };
  } catch (error) {
    if (isS3Status(error, 404)) return null;
    throw error;
  }
}

/**
 * Confirms that a client-provided key belongs to this user and that the object
 * really exists in storage. This prevents attaching arbitrary objects.
 */
export async function requireStoredObject(
  storageKey: string,
  options: {
    scope: UploadScope;
    ownerId: string;
    mimeType?: string;
    sizeBytes?: number;
  },
): Promise<void> {
  if (!isAllowedStorageKey(storageKey, options.scope, options.ownerId)) {
    throw new HttpError(400, "Invalid upload key.");
  }

  if (storageKey.startsWith("/uploads/")) {
    const uploadsRoot = path.resolve(process.cwd(), "public", "uploads");
    const filePath = path.resolve(
      process.cwd(),
      "public",
      storageKey.replace(/^\/+/, ""),
    );
    if (!filePath.startsWith(`${uploadsRoot}${path.sep}`)) {
      throw new HttpError(400, "Invalid upload key.");
    }
    try {
      const info = await stat(filePath);
      if (!info.isFile()) throw new Error("not a file");
      if (info.size > MAX_UPLOAD_BYTES) {
        throw new HttpError(400, "File size exceeds the 10 MB limit.");
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "Upload not found.");
    }
    return;
  }

  if (!objectStorageEnabled()) {
    throw new HttpError(503, "Object storage is not configured.");
  }

  const metadata = await headStoredObject(storageKey);
  if (!metadata) throw new HttpError(400, "Upload not found.");
  if (metadata.contentLength > MAX_UPLOAD_BYTES) {
    throw new HttpError(400, "File size exceeds the 10 MB limit.");
  }
  if (
    options.mimeType &&
    metadata.contentType &&
    metadata.contentType !== options.mimeType
  ) {
    throw new HttpError(400, "Upload content type does not match.");
  }
  if (
    options.sizeBytes !== undefined &&
    options.sizeBytes > 0 &&
    metadata.contentLength !== options.sizeBytes
  ) {
    throw new HttpError(400, "Upload size does not match.");
  }
}

function isS3Status(error: unknown, status: number): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "$metadata" in error &&
    (error as { $metadata?: { httpStatusCode?: number } }).$metadata
      ?.httpStatusCode === status
  );
}

function mimeFromExtension(file: string): string {
  const ext = path.extname(file).slice(1).toLowerCase();
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    webm: "audio/webm",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    mp4: "video/mp4",
    mov: "video/quicktime",
    pdf: "application/pdf",
  };
  return map[ext] ?? "application/octet-stream";
}

async function serveLocalUpload(
  relativeKey: string,
  fallbackMime: string,
): Promise<Response> {
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
 * Streams a private object without exposing storage credentials.
 * Local development uploads (`/uploads/...`) are read from disk instead.
 */
export async function serveStoredAsset(
  storageKey: string,
  fallbackMime = "",
  range: string | null = null,
): Promise<Response> {
  if (!storageKey) return new Response("Not found", { status: 404 });

  if (storageKey.startsWith("/uploads/")) {
    return serveLocalUpload(storageKey, fallbackMime || mimeFromExtension(storageKey));
  }

  if (!objectStorageEnabled()) {
    return new Response("Not found", { status: 404 });
  }

  try {
    const result = await s3Client().send(
      new GetObjectCommand({
        Bucket: env.s3Bucket,
        Key: storageKey,
        ...(range ? { Range: range } : {}),
      }),
    );

    const body = result.Body as
      | { transformToWebStream?: () => ReadableStream }
      | undefined;
    if (!body) return new Response("Not found", { status: 404 });

    const headers = new Headers({
      "cache-control": "private, max-age=300",
      "accept-ranges": "bytes",
    });
    const contentType = result.ContentType || fallbackMime;
    if (contentType) headers.set("content-type", contentType);
    if (result.ContentLength !== undefined) {
      headers.set("content-length", String(result.ContentLength));
    }
    if (result.ContentRange) headers.set("content-range", result.ContentRange);
    if (result.ETag) headers.set("etag", result.ETag);

    const stream =
      typeof body.transformToWebStream === "function"
        ? body.transformToWebStream()
        : (body as unknown as ReadableStream);

    return new Response(stream, {
      status: result.ContentRange ? 206 : 200,
      headers,
    });
  } catch (error) {
    if (isS3Status(error, 416)) {
      return new Response("Range not satisfiable", {
        status: 416,
        headers: { "content-range": "bytes */*" },
      });
    }
    if (!isS3Status(error, 404)) {
      console.error("[storage] read failed", error);
    }
    return new Response("Not found", { status: 404 });
  }
}
