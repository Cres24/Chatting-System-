import * as Ably from "ably";
import { env, realtimeEnabled } from "@/lib/env";

let rest: Ably.Rest | null = null;

function client(): Ably.Rest {
  if (!env.ablyKey) {
    throw new Error("ABLY_API_KEY is not configured.");
  }
  rest ??= new Ably.Rest({ key: env.ablyKey });
  return rest;
}

export function channelForUser(userId: string): string {
  return `user:${userId}`;
}

/**
 * Publish one event to every user's personal channel. Each browser subscribes
 * only to its own channel, which keeps fan-out simple and avoids the client
 * needing to know conversation ids.
 */
export async function publishToUsers(userIds: string[], payload: unknown): Promise<void> {
  if (!realtimeEnabled() || userIds.length === 0) return;
  const unique = Array.from(new Set(userIds));
  const ably = client();

  await Promise.all(
    unique.map(async (userId) => {
      try {
        await ably.channels.get(channelForUser(userId)).publish("event", payload);
      } catch (error) {
        // Realtime is best-effort: the database is still the source of truth.
        console.error("[realtime] publish failed", userId, error);
      }
    }),
  );
}

export async function createRealtimeTokenRequest(
  userId: string,
): Promise<Ably.TokenRequest> {
  return client().auth.createTokenRequest({
    clientId: userId,
    capability: { [channelForUser(userId)]: ["subscribe"] },
    ttl: 60 * 60 * 1000,
  });
}

export function realtimeConfigured(): boolean {
  return realtimeEnabled();
}
