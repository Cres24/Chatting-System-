import { HttpError } from "@/lib/http";
import type { MessageKind } from "@/lib/chat";
import { isAllowedUploadMime, isAllowedUploadUrl } from "@/lib/storage";

export type ValidatedMessage = {
  kind: MessageKind;
  body: string;
  attachment?: { storageKey: string; mimeType: string; sizeBytes: number };
};

export function validateIncomingMessage(input: {
  text: string;
  msg_type: MessageKind;
  attachment?: { url: string; mime_type: string; size: number };
}): ValidatedMessage {
  if (input.msg_type === "text" || input.msg_type === "system") {
    const body = input.text.trim();
    if (!body) throw new HttpError(400, "Message cannot be empty.");
    if (body.length > 4000) throw new HttpError(400, "Message is too long.");
    return { kind: "text", body };
  }

  if (!input.attachment) {
    throw new HttpError(400, "The attachment did not upload correctly.");
  }
  if (!isAllowedUploadMime(input.attachment.mime_type)) {
    throw new HttpError(400, "Only images, audio, and video are supported.");
  }
  if (!isAllowedUploadUrl(input.attachment.url)) {
    throw new HttpError(400, "Invalid attachment URL.");
  }

  return {
    kind: input.msg_type,
    body: "",
    attachment: {
      storageKey: input.attachment.url,
      mimeType: input.attachment.mime_type,
      sizeBytes: input.attachment.size,
    },
  };
}
