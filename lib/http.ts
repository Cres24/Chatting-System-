import { z } from "zod";
import { env } from "./env";

export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ error: error.message }, error.status);
    }
    if (error instanceof z.ZodError) {
      return json({ error: error.issues[0]?.message ?? "Invalid request." }, 400);
    }
    console.error("[api]", error);
    return json({ error: "Internal server error." }, 500);
  }
}

/**
 * Cookie-authenticated endpoints are CSRF-protected by SameSite=Lax plus this
 * origin check. Requests without an Origin header (curl, server-to-server) are
 * allowed.
 */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) return;

  const allowed = new Set<string>();
  try {
    allowed.add(new URL(env.appUrl).origin);
  } catch {
    /* ignore malformed APP_URL */
  }
  try {
    allowed.add(new URL(request.url).origin);
  } catch {
    /* ignore */
  }

  if (!allowed.has(origin)) {
    throw new HttpError(403, "Cross-origin request blocked.");
  }
}

export async function parseJson<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new HttpError(400, "Invalid JSON body.");
  }
  return schema.parse(raw);
}

export function text(value: unknown, max = 4000): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
