/* Shared browser notification helpers for the chat app.
   Used by login.html (permission request) and chat.html (popups, toasts, badges). */
(function (global) {
  const MUTED_KEY = "chat_notify_muted";
  const openNotifications = new Map();

  function supported() {
    return (
      typeof window !== "undefined" &&
      "Notification" in window &&
      window.isSecureContext
    );
  }

  function permission() {
    if (!supported()) return "unsupported";
    return Notification.permission;
  }

  function muted() {
    try {
      return localStorage.getItem(MUTED_KEY) === "true";
    } catch (err) {
      return false;
    }
  }

  function setMuted(value) {
    try {
      localStorage.setItem(MUTED_KEY, value ? "true" : "false");
    } catch (err) {
      /* localStorage may be unavailable in private modes */
    }
  }

  function canNotify() {
    return supported() && Notification.permission === "granted" && !muted();
  }

  function requestPermission() {
    if (!supported()) return Promise.resolve("unsupported");
    try {
      const result = Notification.requestPermission();
      if (result && typeof result.then === "function") {
        return result
          .then((state) => {
            if (state === "granted") setMuted(false);
            return state;
          })
          .catch(() => permission());
      }
    } catch (err) {
      return Promise.resolve(permission());
    }
    // Very old callback-style implementations resolve to undefined above.
    return Promise.resolve(permission());
  }

  function preview(msgType, text) {
    if (msgType === "image") return "📷 Photo";
    if (msgType === "audio") return "🎙️ Voice note";
    if (msgType === "video") return "🎬 Video";

    const value = String(text == null ? "" : text)
      .replace(/\s+/g, " ")
      .trim();
    if (!value) return "New message";
    return value.length > 80 ? value.slice(0, 77) + "..." : value;
  }

  function closeTagged(tag) {
    const existing = openNotifications.get(tag);
    if (!existing) return;
    try {
      existing.close();
    } catch (err) {
      /* already closed */
    }
    openNotifications.delete(tag);
  }

  function notify(options) {
    if (!canNotify()) return false;

    const opts = options || {};
    const tag = opts.tag || "chat-message";

    // Replace the previous popup for the same conversation instead of stacking.
    closeTagged(tag);

    try {
      const notification = new Notification(opts.title || "Chat", {
        body: opts.body || "",
        icon: opts.icon || undefined,
        tag: tag,
        silent: !!opts.silent,
      });

      openNotifications.set(tag, notification);

      notification.onclick = (event) => {
        if (event && typeof event.preventDefault === "function") {
          event.preventDefault();
        }
        try {
          window.focus();
        } catch (err) {
          /* focus can be blocked by the browser */
        }
        if (typeof opts.onclick === "function") {
          try {
            opts.onclick();
          } catch (err) {
            console.error("Notification click handler failed:", err);
          }
        }
        try {
          notification.close();
        } catch (err) {
          /* already closed */
        }
        openNotifications.delete(tag);
      };

      notification.onclose = () => openNotifications.delete(tag);
      notification.onerror = () => openNotifications.delete(tag);

      return true;
    } catch (err) {
      // Android Chrome throws here without a service worker; callers toast instead.
      console.warn("Browser notification could not be shown:", err);
      openNotifications.delete(tag);
      return false;
    }
  }

  global.ChatNotify = {
    supported,
    permission,
    muted,
    setMuted,
    canNotify,
    requestPermission,
    preview,
    notify,
  };
})(window);
