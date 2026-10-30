/**
 * Stored assets live in a private bucket, so the browser never receives the
 * raw key. These helpers turn a stored key into an authenticated proxy URL.
 */
export function userAvatarUrl(userId: string, stored: string | null | undefined): string {
  const value = stored?.trim() ?? "";
  if (!value) return "";
  if (value.startsWith("/uploads/")) return value;
  if (value.startsWith("/api/avatar/")) return value;
  if (
    value.startsWith("avatars/") ||
    value.startsWith("legacy/") ||
    /^https?:\/\//.test(value)
  ) {
    return `/api/avatar/${userId}`;
  }
  return "";
}

export function groupAvatarUrl(
  conversationId: string,
  stored: string | null | undefined,
): string {
  const value = stored?.trim() ?? "";
  if (!value) return "";
  if (value.startsWith("/uploads/")) return value;
  if (value.startsWith("/api/group-avatar/")) return value;
  if (
    value.startsWith("avatars/") ||
    value.startsWith("legacy/") ||
    /^https?:\/\//.test(value)
  ) {
    return `/api/group-avatar/${conversationId}`;
  }
  return "";
}
