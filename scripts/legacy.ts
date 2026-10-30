import { pbkdf2Sync, randomBytes } from "node:crypto";

export type LegacyExport = {
  exported_at: string;
  users: LegacyUser[];
  friends: LegacyFriend[];
  friend_requests: LegacyFriendRequest[];
  blocked_users: LegacyBlock[];
  direct_messages: LegacyDirectMessage[];
  groups: LegacyGroup[];
  group_members: LegacyGroupMember[];
  group_messages: LegacyGroupMessage[];
};

export type LegacyUser = {
  id: number;
  full_name: string;
  username: string;
  email: string;
  password_hash: string;
  password_salt: string;
  avatar: string | null;
};

export type LegacyFriend = { user_id: number; friend_id: number };
export type LegacyFriendRequest = { id: number; from_user: string; to_user: string; status: string };
export type LegacyBlock = { blocker_username: string; blocked_username: string };
export type LegacyDirectMessage = {
  id: number;
  sender: string;
  receiver: string;
  text: string;
  msg_type: string | null;
  timestamp: string;
};
export type LegacyGroup = { id: number; name: string; creator: string; avatar: string | null };
export type LegacyGroupMember = { group_id: number; username: string; role: string | null };
export type LegacyGroupMessage = {
  id: number;
  group_id: number;
  sender: string;
  text: string;
  msg_type: string | null;
  timestamp: string;
};

export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = randomBytes(16).toString("hex");
  const hash = pbkdf2Sync(password, salt, 100_000, 32, "sha256").toString("hex");
  return { hash, salt };
}

export function parseLegacyTimestamp(value: string): Date {
  // SQLite stores UTC as "YYYY-MM-DD HH:MM:SS".
  const iso = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

export function parseDataUrl(dataUrl: string): { buffer: Buffer; mimeType: string } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  return { mimeType: match[1], buffer: Buffer.from(match[2], "base64") };
}

export function extensionFor(mimeType: string): string {
  const map: Record<string, string> = {
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
  return map[mimeType] ?? "bin";
}
