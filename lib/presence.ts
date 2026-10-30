type Timestamped = Date | null;

export const ONLINE_WINDOW_MS = 90_000;

export function isOnline(lastSeenAt: Timestamped): boolean {
  if (!lastSeenAt) return false;
  return Date.now() - lastSeenAt.getTime() < ONLINE_WINDOW_MS;
}

export function displayName(fullName: string, username: string): string {
  return fullName?.trim() || username;
}
