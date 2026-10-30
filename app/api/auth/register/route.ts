import type { NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { hashPassword } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { HttpError, assertSameOrigin, handle, json, parseJson } from "@/lib/http";
import { registerSchema } from "@/lib/schemas";

type PgError = { code?: string };

export async function POST(request: NextRequest): Promise<Response> {
  return handle(async () => {
    assertSameOrigin(request);
    const body = await parseJson(request, registerSchema);
    const db = getDb();

    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(
        sql`lower(${users.username}) = lower(${body.username}) OR lower(${users.email}) = lower(${body.email})`,
      )
      .limit(1);

    if (existing[0]) {
      throw new HttpError(400, "That username or email is already registered.");
    }

    const password = await hashPassword(body.password);

    try {
      await db.insert(users).values({
        fullName: body.full_name,
        username: body.username,
        email: body.email.toLowerCase(),
        passwordHash: password.hash,
        passwordSalt: password.salt,
        passwordIterations: password.iterations,
      });
    } catch (error) {
      if ((error as PgError).code === "23505") {
        throw new HttpError(400, "That username or email is already registered.");
      }
      throw error;
    }

    return json({ message: "Registration successful! You can now log in." });
  });
}
