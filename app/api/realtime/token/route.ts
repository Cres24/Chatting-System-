import { requireUser } from "@/lib/auth";
import { realtimeConfigured, createRealtimeTokenRequest } from "@/lib/realtime";
import { handle, json } from "@/lib/http";

export async function GET(): Promise<Response> {
  return handle(async () => {
    const user = await requireUser();
    if (!realtimeConfigured()) {
      return json({ enabled: false });
    }
    return json({
      enabled: true,
      userId: user.id,
      tokenRequest: await createRealtimeTokenRequest(user.id),
    });
  });
}
