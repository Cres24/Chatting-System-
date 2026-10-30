/**
 * WebSocket compatibility shim.
 *
 * The original UI was written against `new WebSocket(...)` and JSON actions
 * (`resume_session`, `send_message`, ...). This object keeps that interface but
 * calls the REST API, so the existing page code works unchanged.
 */
(function () {
  const jsonHeaders = { "content-type": "application/json" };

  async function request(method, url, body) {
    const response = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? undefined : jsonHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok) {
      const error = new Error(
        (data && data.error) || `Request failed (${response.status})`,
      );
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function enc(value) {
    return encodeURIComponent(String(value));
  }

  function messagesUrl(chatType, targetId) {
    return chatType === "group"
      ? `/api/groups/${enc(targetId)}/messages`
      : `/api/dm/${enc(targetId)}/messages`;
  }

  async function uploadIfNeeded(value, scope) {
    if (typeof value !== "string" || !value.startsWith("data:")) {
      return value || "";
    }
    const file = window.ChatUpload.dataUrlToFile(value, scope);
    const uploaded = await window.ChatUpload.upload(file, scope);
    return uploaded.key;
  }

  async function refreshDashboard() {
    try {
      return await request("GET", "/api/bootstrap");
    } catch {
      return null;
    }
  }

  async function withDashboard(result) {
    return [result, await refreshDashboard()];
  }

  const actions = {
    async resume_session() {
      return await request("GET", "/api/bootstrap");
    },

    async load_chat(payload) {
      return await request("GET", messagesUrl(payload.chat_type, payload.target_id));
    },

    async send_message(payload) {
      let attachment;
      if (
        payload.msg_type &&
        payload.msg_type !== "text" &&
        typeof payload.text === "string" &&
        payload.text.startsWith("data:")
      ) {
        const file = window.ChatUpload.dataUrlToFile(payload.text, payload.msg_type);
        attachment = await window.ChatUpload.upload(file, "media");
      }

      const data = await request(
        "POST",
        messagesUrl(payload.chat_type, payload.target_id),
        {
          text: attachment ? "" : payload.text || "",
          msg_type: payload.msg_type || "text",
          attachment,
        },
      );
      return data.message;
    },

    async send_friend_request(payload) {
      const result = await request("POST", "/api/friends/requests", {
        to_user: payload.to_user,
      });
      return withDashboard(result);
    },

    async accept_friend_request(payload) {
      const result = await request("POST", "/api/friends/requests/accept", {
        from_user: payload.from_user,
      });
      return withDashboard(result);
    },

    async unfriend(payload) {
      const result = await request(
        "DELETE",
        `/api/friends/${enc(payload.target_username)}`,
      );
      return withDashboard(result);
    },

    async block(payload) {
      const result = await request("POST", "/api/blocks", {
        target_username: payload.target_username,
      });
      return withDashboard(result);
    },

    async unblock(payload) {
      const result = await request(
        "DELETE",
        `/api/blocks/${enc(payload.target_username)}`,
      );
      return withDashboard(result);
    },

    async create_group(payload) {
      const result = await request("POST", "/api/groups", {
        name: payload.name,
        members: payload.members || [],
      });
      return withDashboard(result);
    },

    async update_group_info(payload) {
      const avatar = await uploadIfNeeded(payload.avatar, "avatars");
      const result = await request(
        "PATCH",
        `/api/groups/${enc(payload.group_id)}`,
        { name: payload.name, avatar },
      );
      return withDashboard(result);
    },

    async add_group_member(payload) {
      const result = await request(
        "POST",
        `/api/groups/${enc(payload.group_id)}/members`,
        { target_username: payload.target_username },
      );
      return withDashboard(result);
    },

    async remove_group_member(payload) {
      const result = await request(
        "DELETE",
        `/api/groups/${enc(payload.group_id)}/members/${enc(payload.target_username)}`,
      );
      return withDashboard(result);
    },

    async promote_admin(payload) {
      const result = await request(
        "POST",
        `/api/groups/${enc(payload.group_id)}/members/${enc(payload.target_username)}/promote`,
      );
      return withDashboard(result);
    },

    async leave_group(payload) {
      const result = await request(
        "POST",
        `/api/groups/${enc(payload.group_id)}/leave`,
      );
      return withDashboard(result);
    },

    async update_profile(payload) {
      const avatar = await uploadIfNeeded(payload.avatar, "avatars");
      const data = await request("PATCH", "/api/me", {
        current_password: payload.current_password,
        new_fullname: payload.new_fullname,
        new_username: payload.new_username,
        new_email: payload.new_email,
        new_password: payload.new_password || "",
        avatar,
      });
      return { action: "profile_success", user: data.user };
    },

    async login(payload) {
      const data = await request("POST", "/api/auth/login", {
        identifier: payload.identifier,
        password: payload.password,
      });
      return { action: "login_success", user: data.user };
    },

    async register(payload) {
      const data = await request("POST", "/api/auth/register", {
        full_name: payload.full_name,
        username: payload.username,
        email: payload.email,
        password: payload.password,
      });
      return { action: "register_success", text: data.message };
    },

    async logout() {
      await request("POST", "/api/auth/logout");
      return { action: "logout_success" };
    },
  };

  function errorAction(action) {
    if (action === "login" || action === "register") return "auth_error";
    if (action === "update_profile") return "profile_error";
    return "alert";
  }

  function dispatch(sock, action, payload) {
    const handler = actions[action];
    if (!handler) {
      console.warn("[socket-shim] Unsupported action:", action);
      return;
    }

    Promise.resolve(handler(payload))
      .then((result) => {
        const list = Array.isArray(result) ? result : [result];
        for (const item of list) {
          if (!item) continue;
          if (sock.onmessage) sock.onmessage({ data: JSON.stringify(item) });
        }
      })
      .catch((error) => {
        if (error.status === 401) {
          window.location.replace("login.html");
          return;
        }
        console.error("[socket-shim]", action, error);
        if (sock.onmessage) {
          sock.onmessage({
            data: JSON.stringify({
              action: errorAction(action),
              text: error.message || "Something went wrong.",
            }),
          });
        }
      });
  }

  function createChatSocket() {
    const sock = {
      readyState: 1,
      CONNECTING: 0,
      OPEN: 1,
      CLOSING: 2,
      CLOSED: 3,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send(raw) {
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch {
          console.warn("[socket-shim] Ignoring non-JSON message.");
          return;
        }
        dispatch(sock, payload.action, payload);
      },
      close() {
        sock.readyState = 3;
        if (sock.onclose) sock.onclose({});
      },
    };

    if (window.ChatRealtime) window.ChatRealtime.start(sock);
    setTimeout(() => {
      if (sock.onopen) sock.onopen({});
    }, 0);

    return sock;
  }

  window.createChatSocket = createChatSocket;
})();
