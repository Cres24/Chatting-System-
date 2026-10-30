import { z } from "zod";

export const usernameSchema = z
  .string()
  .trim()
  .min(2, "Username must be at least 2 characters.")
  .max(80, "Username is too long.")
  .regex(
    /^[A-Za-z0-9._@+-]+$/,
    "Username can only contain letters, numbers, and . _ @ + -",
  );

export const registerSchema = z.object({
  full_name: z.string().trim().min(1, "Full name is required.").max(120),
  username: usernameSchema,
  email: z.string().trim().email("Enter a valid email address.").max(160),
  password: z
    .string()
    .min(6, "Password must be at least 6 characters.")
    .max(200),
});

export const loginSchema = z.object({
  identifier: z.string().trim().min(1, "Username or email is required.").max(160),
  password: z.string().min(1, "Password is required.").max(200),
});

export const profileSchema = z.object({
  current_password: z.string().min(1, "Current password is required.").max(200),
  new_fullname: z.string().trim().min(1, "Full name is required.").max(120),
  new_username: usernameSchema,
  new_email: z.string().trim().email("Enter a valid email address.").max(160),
  new_password: z.string().max(200).optional().default(""),
  avatar: z.string().max(500).optional().default(""),
});

export const attachmentSchema = z.object({
  url: z.string().min(1).max(1000),
  mime_type: z.string().min(1).max(120),
  size: z.number().int().nonnegative().max(10 * 1024 * 1024),
});

export const messageSchema = z.object({
  text: z.string().max(10_000).optional().default(""),
  msg_type: z
    .enum(["text", "image", "audio", "video", "file", "system"])
    .optional()
    .default("text"),
  attachment: attachmentSchema.optional(),
});

export const friendRequestSchema = z.object({
  to_user: usernameSchema,
});

export const acceptRequestSchema = z.object({
  from_user: usernameSchema,
});

export const usernameBodySchema = z.object({
  target_username: usernameSchema,
});

export const createGroupSchema = z.object({
  name: z.string().trim().min(1, "Group name is required.").max(80),
  members: z.array(usernameSchema).max(100).optional().default([]),
  avatar: z.string().max(1000).optional().default(""),
});

export const updateGroupSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  avatar: z.string().max(1000).optional(),
});

export const updateMeSchema = z.object({
  avatar: z.string().max(1000).optional(),
});
