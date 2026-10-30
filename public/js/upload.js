/**
 * Uploads for the plain-HTML frontend.
 *
 * - With Neon Object Storage configured, browsers receive a short-lived
 *   presigned S3 PUT URL and upload directly to the private bucket.
 * - In local development without object storage, files go to /api/uploads/dev.
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
   * @returns {Promise<{key: string, mime_type: string, size: number}>}
   */
  async function upload(file, scope) {
    const config = await getConfig();

    if (config.mode === "s3") {
      const targetResponse = await fetch("/api/uploads", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope,
          content_type: file.type,
          size: file.size,
        }),
      });
      const target = await targetResponse.json().catch(() => ({}));
      if (!targetResponse.ok) {
        throw new Error(target.error || "Could not prepare the upload.");
      }

      const putResponse = await fetch(target.uploadUrl, {
        method: "PUT",
        headers: target.headers || { "content-type": file.type },
        body: file,
      });
      if (!putResponse.ok) {
        throw new Error(
          `Storage rejected the upload (${putResponse.status}). Check the bucket CORS rules.`,
        );
      }

      return {
        key: target.key,
        mime_type: file.type,
        size: file.size,
      };
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
      return { key: data.key, mime_type: data.mimeType, size: data.size };
    }

    throw new Error("File uploads are not configured on this deployment.");
  }

  window.ChatUpload = { upload, dataUrlToFile };
})();
