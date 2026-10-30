/**
 * Uploads for the plain-HTML frontend.
 *
 * - With a Blob store configured, browsers upload directly to Vercel Blob using
 *   a short-lived token from /api/uploads.
 * - In local development without Blob, files go to /api/uploads/dev.
 */
(function () {
  let configPromise = null;

  function getConfig() {
    if (!configPromise) {
      configPromise = fetch("/api/uploads/config", {
        credentials: "same-origin",
      }).then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data.error || "Could not load upload settings.");
        }
        return data;
      });
    }
    return configPromise;
  }

  function extensionFor(mimeType) {
    const map = {
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
    return map[mimeType] || "bin";
  }

  function randomId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  /** Converts the legacy FileReader data URLs used by chat.html into a File. */
  function dataUrlToFile(dataUrl, kind) {
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
    if (!match) throw new Error("Invalid file data.");
    const mimeType = match[1];
    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    const ext = extensionFor(mimeType);
    return new File([bytes], `${kind || "upload"}-${Date.now()}.${ext}`, {
      type: mimeType,
    });
  }

  /**
   * @param {File} file
   * @param {"media"|"avatars"} scope
   * @returns {Promise<{url: string, mime_type: string, size: number}>}
   */
  async function upload(file, scope) {
    const config = await getConfig();

    if (config.mode === "blob") {
      if (!window.VercelBlob || typeof window.VercelBlob.upload !== "function") {
        throw new Error("Upload library failed to load.");
      }
      const pathname = `${scope}/${config.userId}/${randomId()}.${extensionFor(file.type)}`;
      const result = await window.VercelBlob.upload(pathname, file, {
        access: config.access,
        handleUploadUrl: "/api/uploads",
        clientPayload: JSON.stringify({ scope }),
        onUploadProgress: (event) => {
          window.dispatchEvent(
            new CustomEvent("chat-upload-progress", { detail: event }),
          );
        },
      });
      return { url: result.url, mime_type: file.type, size: file.size };
    }

    if (config.mode === "dev") {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/uploads/dev", {
        method: "POST",
        credentials: "same-origin",
        body: form,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Upload failed.");
      }
      return { url: data.url, mime_type: data.mimeType, size: data.size };
    }

    throw new Error("File uploads are not configured on this deployment.");
  }

  window.ChatUpload = { upload, dataUrlToFile };
})();
