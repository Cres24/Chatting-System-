import type { NextRequest } from "next/server";
import { destroySession } from "@/lib/auth";
import { assertSameOrigin, handle, json } from "@/lib/http";

export async function POST(request: NextRequest): Promise<Response> {
  return handle(async () => {
    assertSameOrigin(request);
    await destroySession();
    return json({ ok: true });
  });
}
