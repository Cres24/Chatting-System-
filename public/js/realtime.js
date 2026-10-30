/**
 * Realtime transport for the plain-HTML frontend.
 *
 * Production: Ably pushes events to the signed-in user's personal channel.
 * Local development without ABLY_API_KEY: the client polls the REST API so the
 * app is still usable without any cloud account.
 */
(function () {
  let socket = null;
  let ablyClient = null;
  let pollTimer = null;
  let heartbeatTimer = null;
  let watching = null;
  let started = false;

  function emit(payload) {
    if (!payload || !socket || typeof socket.onmessage !== "function") return;
    const list = Array.isArray(payload) ? payload : [payload];
    for (const item of list) {
      if (!item) continue;
      try {
        socket.onmessage({ data: JSON.stringify(item) });
      } catch (error) {
        console.error("[realtime] handler failed", error);
      }
    }
  }

  async function getJson(url, options) {
    const response = await fetch(url, {
      credentials: "same-origin",
      ...options,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function messageUrl(type, id) {
    return type === "group"
      ? `/api/groups/${encodeURIComponent(id)}/messages`
      : `/api/dm/${encodeURIComponent(id)}/messages`;
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function pollOnce() {
    if (document.visibilityState !== "visible") return;
    try {
      emit(await getJson("/api/bootstrap"));
      if (watching) {
        emit(await getJson(messageUrl(watching.type, watching.id)));
      }
    } catch (error) {
      if (error.status === 401) {
        window.location.replace("login.html");
      }
    }
  }

  function startPolling() {
    if (pollTimer) return;
    pollOnce();
    pollTimer = setInterval(pollOnce, 12000);
  }

  function startHeartbeat() {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(async () => {
      if (document.visibilityState !== "visible") return;
      try {
        emit(await getJson("/api/heartbeat", { method: "POST" }));
      } catch (error) {
        if (error.status === 401) {
          window.location.replace("login.html");
        }
      }
    }, 60000);
  }

  function connectAbly(config) {
    if (!window.Ably || typeof window.Ably.Realtime !== "function") {
      console.warn("[realtime] Ably bundle missing; falling back to polling.");
      startPolling();
      return;
    }

    ablyClient = new window.Ably.Realtime({
      authCallback: async (_tokenParams, callback) => {
        try {
          const fresh = await getJson("/api/realtime/token");
          if (!fresh.enabled) throw new Error("Realtime is disabled.");
          callback(null, fresh.tokenRequest);
        } catch (error) {
          callback(error);
        }
      },
      clientId: config.userId,
    });

    ablyClient.connection.on("connected", () => {
      stopPolling();
      ablyClient.channels
        .get(`user:${config.userId}`)
        .subscribe((message) => emit(message.data));
    });

    ablyClient.connection.on("failed", () => {
      console.warn("[realtime] Ably connection failed; falling back to polling.");
      startPolling();
    });

    ablyClient.connection.on("suspended", () => {
      startPolling();
    });

    startHeartbeat();
  }

  async function start(sock) {
    socket = sock;
    if (started) return;
    started = true;

    // Auth pages only use the shim for login/register actions; there is no
    // session yet, so skip the realtime token request entirely.
    const path = window.location.pathname;
    if (path === "/" || /\/(login|register|index)\.html$/.test(path)) return;

    try {
      const config = await getJson("/api/realtime/token");
      if (config.enabled) {
        connectAbly(config);
        return;
      }
    } catch (error) {
      if (error.status === 401) {
        // Login/register pages are unauthenticated by design; nothing to do.
        return;
      }
      console.warn("[realtime] token request failed; using polling.", error);
    }

    startPolling();
  }

  function watch(type, id) {
    watching = type && id ? { type, id } : null;
  }

  window.ChatRealtime = { start, watch };
})();
