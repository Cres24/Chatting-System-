import asyncio
import json
import logging
import sqlite3
import hashlib
import secrets
import os
from websockets.asyncio.server import serve

logging.basicConfig(level=logging.INFO)

DB_FILE = "chat.db"
ONLINE_USERS = {}  # username -> websocket connection

# ----------------- SECURITY & PASSWORD HASHING -----------------

def hash_password(password: str, salt: str = None) -> tuple[str, str]:
    if not salt:
        salt = secrets.token_hex(16)
    key = hashlib.pbkdf2_hmac(
        'sha256',
        password.encode('utf-8'),
        salt.encode('utf-8'),
        100000
    ).hex()
    return key, salt

def verify_password(stored_hash: str, salt: str, password_attempt: str) -> bool:
    new_hash, _ = hash_password(password_attempt, salt)
    return secrets.compare_digest(stored_hash, new_hash)

# ----------------- DATABASE INITIALIZATION & QUERIES -----------------

def init_db():
    with sqlite3.connect(DB_FILE) as conn:
        c = conn.cursor()
        c.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                full_name TEXT NOT NULL,
                username TEXT UNIQUE NOT NULL,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                password_salt TEXT NOT NULL,
                avatar TEXT DEFAULT ''
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS friends (
                user_id INTEGER,
                friend_id INTEGER,
                PRIMARY KEY (user_id, friend_id)
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS blocked_users (
                blocker_username TEXT NOT NULL,
                blocked_username TEXT NOT NULL,
                PRIMARY KEY (blocker_username, blocked_username)
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS friend_requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                from_user TEXT NOT NULL,
                to_user TEXT NOT NULL,
                status TEXT DEFAULT 'pending'
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS direct_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sender TEXT NOT NULL,
                receiver TEXT NOT NULL,
                text TEXT NOT NULL,
                msg_type TEXT DEFAULT 'text',
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS groups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                creator TEXT NOT NULL
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS group_members (
                group_id INTEGER,
                username TEXT NOT NULL,
                PRIMARY KEY (group_id, username)
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS group_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id INTEGER NOT NULL,
                sender TEXT NOT NULL,
                text TEXT NOT NULL,
                msg_type TEXT DEFAULT 'text',
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)

        # Migrations
        try:
            c.execute("ALTER TABLE users ADD COLUMN avatar TEXT DEFAULT ''")
        except sqlite3.OperationalError:
            pass
        try:
            c.execute("ALTER TABLE direct_messages ADD COLUMN msg_type TEXT DEFAULT 'text'")
        except sqlite3.OperationalError:
            pass
        try:
            c.execute("ALTER TABLE group_messages ADD COLUMN msg_type TEXT DEFAULT 'text'")
        except sqlite3.OperationalError:
            pass

        conn.commit()

def register_user(full_name: str, username: str, email: str, password: str):
    p_hash, salt = hash_password(password)
    try:
        with sqlite3.connect(DB_FILE) as conn:
            c = conn.cursor()
            c.execute("""
                INSERT INTO users (full_name, username, email, password_hash, password_salt, avatar)
                VALUES (?, ?, ?, ?, ?, '')
            """, (full_name, username, email.lower(), p_hash, salt))
            conn.commit()
            return True, "Registration successful! You can now log in."
    except sqlite3.IntegrityError as e:
        err_msg = str(e).lower()
        if "username" in err_msg:
            return False, "Username is already taken."
        elif "email" in err_msg:
            return False, "Email is already registered."
        return False, "Account already exists."

def authenticate_user(identifier: str, password: str):
    with sqlite3.connect(DB_FILE) as conn:
        c = conn.cursor()
        c.execute("""
            SELECT full_name, username, email, password_hash, password_salt, COALESCE(avatar, '')
            FROM users
            WHERE username = ? OR email = ?
        """, (identifier, identifier.lower()))
        user = c.fetchone()
        if not user:
            return None, "Invalid username or password."

        full_name, username, email, p_hash, salt, avatar = user
        if verify_password(p_hash, salt, password):
            return {
                "full_name": full_name, 
                "username": username, 
                "email": email, 
                "avatar": avatar
            }, "Success"
        return None, "Invalid username or password."

def update_user_profile(current_user: str, current_password: str, new_fullname: str, new_username: str, new_email: str, new_password: str = None, avatar: str = None):
    try:
        with sqlite3.connect(DB_FILE) as conn:
            c = conn.cursor()

            c.execute("SELECT password_hash, password_salt, avatar FROM users WHERE username = ?", (current_user,))
            row = c.fetchone()
            if not row:
                return False, "User not found."

            stored_hash, salt, existing_avatar = row
            if not verify_password(stored_hash, salt, current_password):
                return False, "Incorrect current password. Verification failed."

            final_avatar = avatar if avatar is not None else existing_avatar

            if new_password and new_password.strip():
                p_hash, new_salt = hash_password(new_password)
                c.execute("""
                    UPDATE users 
                    SET full_name = ?, username = ?, email = ?, password_hash = ?, password_salt = ?, avatar = ?
                    WHERE username = ?
                """, (new_fullname, new_username, new_email.lower(), p_hash, new_salt, final_avatar, current_user))
            else:
                c.execute("""
                    UPDATE users 
                    SET full_name = ?, username = ?, email = ?, avatar = ?
                    WHERE username = ?
                """, (new_fullname, new_username, new_email.lower(), final_avatar, current_user))

            if current_user != new_username:
                c.execute("UPDATE friend_requests SET from_user = ? WHERE from_user = ?", (new_username, current_user))
                c.execute("UPDATE friend_requests SET to_user = ? WHERE to_user = ?", (new_username, current_user))
                c.execute("UPDATE direct_messages SET sender = ? WHERE sender = ?", (new_username, current_user))
                c.execute("UPDATE direct_messages SET receiver = ? WHERE receiver = ?", (new_username, current_user))
                c.execute("UPDATE groups SET creator = ? WHERE creator = ?", (new_username, current_user))
                c.execute("UPDATE group_members SET username = ? WHERE username = ?", (new_username, current_user))
                c.execute("UPDATE group_messages SET sender = ? WHERE sender = ?", (new_username, current_user))
                c.execute("UPDATE blocked_users SET blocker_username = ? WHERE blocker_username = ?", (new_username, current_user))
                c.execute("UPDATE blocked_users SET blocked_username = ? WHERE blocked_username = ?", (new_username, current_user))

            conn.commit()
            return True, "Profile updated successfully."
    except sqlite3.IntegrityError as e:
        err = str(e).lower()
        if "username" in err:
            return False, "This username is already taken."
        elif "email" in err:
            return False, "This email is already in use."
        return False, "Failed to update profile."

def get_friends(username: str):
    with sqlite3.connect(DB_FILE) as conn:
        c = conn.cursor()
        c.execute("""
            SELECT u2.username, u2.full_name, COALESCE(u2.avatar, '') FROM users u1
            JOIN friends f ON u1.id = f.user_id
            JOIN users u2 ON f.friend_id = u2.id
            WHERE u1.username = ?
        """, (username,))
        return [{"username": row[0], "full_name": row[1], "avatar": row[2]} for row in c.fetchall()]

def get_blocked_users(username: str):
    with sqlite3.connect(DB_FILE) as conn:
        c = conn.cursor()
        c.execute("SELECT blocked_username FROM blocked_users WHERE blocker_username = ?", (username,))
        return [row[0] for row in c.fetchall()]

def is_blocked_pair(user_a: str, user_b: str) -> bool:
    with sqlite3.connect(DB_FILE) as conn:
        c = conn.cursor()
        c.execute("""
            SELECT 1 FROM blocked_users 
            WHERE (blocker_username = ? AND blocked_username = ?)
               OR (blocker_username = ? AND blocked_username = ?)
        """, (user_a, user_b, user_b, user_a))
        return c.fetchone() is not None

def unfriend_user(user_a: str, user_b: str):
    with sqlite3.connect(DB_FILE) as conn:
        c = conn.cursor()
        c.execute("SELECT id FROM users WHERE username = ?", (user_a,))
        u1_row = c.fetchone()
        c.execute("SELECT id FROM users WHERE username = ?", (user_b,))
        u2_row = c.fetchone()
        if u1_row and u2_row:
            u1, u2 = u1_row[0], u2_row[0]
            c.execute("DELETE FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)", (u1, u2, u2, u1))
            conn.commit()

def block_user(blocker: str, blocked: str):
    unfriend_user(blocker, blocked)
    with sqlite3.connect(DB_FILE) as conn:
        c = conn.cursor()
        c.execute("INSERT OR IGNORE INTO blocked_users (blocker_username, blocked_username) VALUES (?, ?)", (blocker, blocked))
        c.execute("""
            DELETE FROM friend_requests 
            WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)
        """, (blocker, blocked, blocked, blocker))
        conn.commit()

def unblock_user(blocker: str, blocked: str):
    with sqlite3.connect(DB_FILE) as conn:
        c = conn.cursor()
        c.execute("DELETE FROM blocked_users WHERE blocker_username = ? AND blocked_username = ?", (blocker, blocked))
        conn.commit()

def get_pending_requests(username: str):
    with sqlite3.connect(DB_FILE) as conn:
        c = conn.cursor()
        c.execute("SELECT from_user FROM friend_requests WHERE to_user = ? AND status = 'pending'", (username,))
        return [row[0] for row in c.fetchall()]

def add_friend_request(from_user: str, to_user: str):
    if from_user == to_user:
        return False, "You cannot add yourself."
    if is_blocked_pair(from_user, to_user):
        return False, "Cannot send request: interaction is blocked."

    with sqlite3.connect(DB_FILE) as conn:
        c = conn.cursor()
        c.execute("SELECT id FROM users WHERE username = ?", (to_user,))
        if not c.fetchone():
            return False, "User does not exist."

        friends = [f["username"] for f in get_friends(from_user)]
        if to_user in friends:
            return False, "Already friends."

        c.execute("SELECT id FROM friend_requests WHERE from_user = ? AND to_user = ? AND status = 'pending'", (from_user, to_user))
        if c.fetchone():
            return False, "Request already sent."
        c.execute("INSERT INTO friend_requests (from_user, to_user) VALUES (?, ?)", (from_user, to_user))
        conn.commit()
        return True, "Request sent."

def accept_request(from_user: str, to_user: str):
    if is_blocked_pair(from_user, to_user):
        return
    with sqlite3.connect(DB_FILE) as conn:
        c = conn.cursor()
        c.execute("SELECT id FROM users WHERE username = ?", (from_user,))
        u1 = c.fetchone()[0]
        c.execute("SELECT id FROM users WHERE username = ?", (to_user,))
        u2 = c.fetchone()[0]
        c.execute("INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)", (u1, u2))
        c.execute("INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)", (u2, u1))
        c.execute("DELETE FROM friend_requests WHERE from_user = ? AND to_user = ?", (from_user, to_user))
        conn.commit()

def create_group(name: str, creator: str, members: list[str]) -> int:
    with sqlite3.connect(DB_FILE) as conn:
        c = conn.cursor()
        c.execute("INSERT INTO groups (name, creator) VALUES (?, ?)", (name, creator))
        group_id = c.lastrowid
        all_members = set(members + [creator])
        for member in all_members:
            c.execute("INSERT INTO group_members (group_id, username) VALUES (?, ?)", (group_id, member))
        conn.commit()
        return group_id

def get_user_groups(username: str):
    with sqlite3.connect(DB_FILE) as conn:
        c = conn.cursor()
        c.execute("""
            SELECT g.id, g.name FROM groups g
            JOIN group_members gm ON g.id = gm.group_id
            WHERE gm.username = ?
        """, (username,))
        return [{"id": row[0], "name": row[1]} for row in c.fetchall()]

def get_group_members_with_status(group_id: int):
    with sqlite3.connect(DB_FILE) as conn:
        c = conn.cursor()
        c.execute("""
            SELECT gm.username, u.full_name, COALESCE(u.avatar, '')
            FROM group_members gm
            LEFT JOIN users u ON gm.username = u.username
            WHERE gm.group_id = ?
        """, (group_id,))
        rows = c.fetchall()
        return [
            {
                "username": row[0],
                "full_name": row[1] or row[0],
                "avatar": row[2],
                "online": row[0] in ONLINE_USERS
            }
            for row in rows
        ]

def save_direct_message(sender: str, receiver: str, text: str, msg_type: str = "text"):
    with sqlite3.connect(DB_FILE) as conn:
        c = conn.cursor()
        c.execute("INSERT INTO direct_messages (sender, receiver, text, msg_type) VALUES (?, ?, ?, ?)", 
                  (sender, receiver, text, msg_type))
        conn.commit()

def save_group_message(group_id: int, sender: str, text: str, msg_type: str = "text"):
    with sqlite3.connect(DB_FILE) as conn:
        c = conn.cursor()
        c.execute("INSERT INTO group_messages (group_id, sender, text, msg_type) VALUES (?, ?, ?, ?)", 
                  (group_id, sender, text, msg_type))
        conn.commit()

def get_direct_history(u1: str, u2: str):
    with sqlite3.connect(DB_FILE) as conn:
        c = conn.cursor()
        c.execute("""
            SELECT dm.sender, dm.text, COALESCE(dm.msg_type, 'text'), COALESCE(u.avatar, '')
            FROM direct_messages dm
            LEFT JOIN users u ON dm.sender = u.username
            WHERE (dm.sender = ? AND dm.receiver = ?) OR (dm.sender = ? AND dm.receiver = ?)
            ORDER BY dm.timestamp ASC LIMIT 50
        """, (u1, u2, u2, u1))
        return [
            {"sender": row[0], "text": row[1], "msg_type": row[2], "avatar": row[3]}
            for row in c.fetchall()
        ]

def get_group_history(group_id: int):
    with sqlite3.connect(DB_FILE) as conn:
        c = conn.cursor()
        c.execute("""
            SELECT gm.sender, gm.text, COALESCE(gm.msg_type, 'text'), COALESCE(u.avatar, '')
            FROM group_messages gm
            LEFT JOIN users u ON gm.sender = u.username
            WHERE gm.group_id = ?
            ORDER BY gm.timestamp ASC LIMIT 50
        """, (group_id,))
        return [
            {"sender": row[0], "text": row[1], "msg_type": row[2], "avatar": row[3]}
            for row in c.fetchall()
        ]

# ----------------- NOTIFICATION & SYNC HELPERS -----------------

async def send_json(ws, data: dict):
    if ws:
        try:
            await ws.send(json.dumps(data))
        except Exception:
            pass

async def sync_user_dashboard(username: str):
    ws = ONLINE_USERS.get(username)
    if not ws:
        return
    friends = get_friends(username)
    friends_status = [
        {"username": f["username"], "full_name": f["full_name"], "avatar": f["avatar"], "online": f["username"] in ONLINE_USERS}
        for f in friends
    ]
    pending = get_pending_requests(username)
    groups = get_user_groups(username)
    blocked = get_blocked_users(username)

    await send_json(ws, {
        "action": "dashboard_sync",
        "friends": friends_status,
        "requests": pending,
        "groups": groups,
        "blocked": blocked
    })

# ----------------- CLIENT HANDLER -----------------

async def handle_client(websocket):
    current_user = None
    try:
        async for raw_message in websocket:
            data = json.loads(raw_message)
            action = data.get("action")

            if action == "register":
                full_name = data.get("full_name", "").strip()
                username = data.get("username", "").strip()
                email = data.get("email", "").strip()
                password = data.get("password", "")

                if not (full_name and username and email and password):
                    await send_json(websocket, {"action": "auth_error", "text": "All fields are required."})
                    continue

                success, message = register_user(full_name, username, email, password)
                if success:
                    await send_json(websocket, {"action": "register_success", "text": message})
                else:
                    await send_json(websocket, {"action": "auth_error", "text": message})

            elif action == "login":
                identifier = data.get("identifier", "").strip()
                password = data.get("password", "")

                user_profile, msg = authenticate_user(identifier, password)
                if not user_profile:
                    await send_json(websocket, {"action": "auth_error", "text": msg})
                    continue

                current_user = user_profile["username"]
                ONLINE_USERS[current_user] = websocket
                logging.info(f"{current_user} authenticated.")

                await send_json(websocket, {
                    "action": "login_success",
                    "user": user_profile
                })
                await sync_user_dashboard(current_user)

                for friend in get_friends(current_user):
                    if friend["username"] in ONLINE_USERS:
                        await sync_user_dashboard(friend["username"])

            elif action == "resume_session":
                current_user = data.get("username", "").strip()
                if current_user:
                    ONLINE_USERS[current_user] = websocket
                    logging.info(f"{current_user} resumed session.")
                    await sync_user_dashboard(current_user)
                    for friend in get_friends(current_user):
                        if friend["username"] in ONLINE_USERS:
                            await sync_user_dashboard(friend["username"])

            elif action == "update_profile":
                curr_user = data.get("current_username", "").strip()
                curr_pw = data.get("current_password", "")
                new_fn = data.get("new_fullname", "").strip()
                new_un = data.get("new_username", "").strip()
                new_em = data.get("new_email", "").strip()
                new_pw = data.get("new_password", "")
                new_avatar = data.get("avatar", "")

                if not curr_pw:
                    await send_json(websocket, {
                        "action": "profile_error",
                        "text": "Current password is required."
                    })
                    continue

                success, msg = update_user_profile(curr_user, curr_pw, new_fn, new_un, new_em, new_pw, new_avatar)
                if success:
                    if curr_user != new_un:
                        if curr_user in ONLINE_USERS:
                            del ONLINE_USERS[curr_user]
                        ONLINE_USERS[new_un] = websocket
                        current_user = new_un

                    await send_json(websocket, {
                        "action": "profile_success",
                        "user": {
                            "full_name": new_fn,
                            "username": new_un,
                            "email": new_em,
                            "avatar": new_avatar
                        }
                    })
                    await sync_user_dashboard(new_un)
                    for friend in get_friends(new_un):
                        if friend["username"] in ONLINE_USERS:
                            await sync_user_dashboard(friend["username"])
                else:
                    await send_json(websocket, {
                        "action": "profile_error",
                        "text": msg
                    })

            elif action == "send_friend_request":
                if not current_user:
                    continue
                target = data.get("to_user", "").strip()
                success, msg = add_friend_request(current_user, target)
                await send_json(websocket, {"action": "alert", "text": msg})
                if success and target in ONLINE_USERS:
                    await sync_user_dashboard(target)

            elif action == "accept_friend_request":
                if not current_user:
                    continue
                from_user = data.get("from_user")
                accept_request(from_user, current_user)
                await sync_user_dashboard(current_user)
                if from_user in ONLINE_USERS:
                    await sync_user_dashboard(from_user)

            elif action == "unfriend":
                if not current_user:
                    continue
                target = data.get("target_username")
                unfriend_user(current_user, target)
                await sync_user_dashboard(current_user)
                if target in ONLINE_USERS:
                    await sync_user_dashboard(target)

            elif action == "block":
                if not current_user:
                    continue
                target = data.get("target_username")
                block_user(current_user, target)
                await sync_user_dashboard(current_user)
                if target in ONLINE_USERS:
                    await sync_user_dashboard(target)

            elif action == "unblock":
                if not current_user:
                    continue
                target = data.get("target_username")
                unblock_user(current_user, target)
                await sync_user_dashboard(current_user)

            elif action == "create_group":
                if not current_user:
                    continue
                name = data.get("name", "").strip()
                members = data.get("members", [])
                if not name:
                    await send_json(websocket, {"action": "alert", "text": "Group name is required."})
                    continue

                group_id = create_group(name, current_user, members)
                group_members_list = [m["username"] for m in get_group_members_with_status(group_id)]
                for member in group_members_list:
                    if member in ONLINE_USERS:
                        await sync_user_dashboard(member)

            elif action == "load_chat":
                if not current_user:
                    continue
                chat_type = data.get("chat_type")
                target_id = data.get("target_id")
                members = []

                if chat_type == "direct":
                    history = get_direct_history(current_user, target_id)
                else:
                    group_id = int(target_id)
                    history = get_group_history(group_id)
                    members = get_group_members_with_status(group_id)

                await send_json(websocket, {
                    "action": "chat_history",
                    "chat_type": chat_type,
                    "target_id": target_id,
                    "history": history,
                    "members": members
                })

            elif action == "send_message":
                if not current_user:
                    continue
                chat_type = data.get("chat_type")
                target_id = data.get("target_id")
                text = data.get("text", "").strip()
                msg_type = data.get("msg_type", "text")

                if not text:
                    continue

                if chat_type == "direct":
                    if is_blocked_pair(current_user, target_id):
                        await send_json(websocket, {"action": "alert", "text": "Message blocked: communication is not allowed."})
                        continue

                    # Fetch sender avatar
                    with sqlite3.connect(DB_FILE) as conn:
                        c = conn.cursor()
                        c.execute("SELECT COALESCE(avatar, '') FROM users WHERE username = ?", (current_user,))
                        row = c.fetchone()
                        sender_avatar = row[0] if row else ""

                    save_direct_message(current_user, target_id, text, msg_type)
                    payload = {
                        "action": "new_message",
                        "chat_type": "direct",
                        "target_id": current_user,
                        "sender": current_user,
                        "text": text,
                        "msg_type": msg_type,
                        "avatar": sender_avatar
                    }
                    if target_id in ONLINE_USERS:
                        await send_json(ONLINE_USERS[target_id], payload)
                    await send_json(websocket, {**payload, "target_id": target_id})

                elif chat_type == "group":
                    group_id = int(target_id)
                    member_data = get_group_members_with_status(group_id)
                    member_names = [m["username"] for m in member_data]

                    if current_user not in member_names:
                        continue

                    with sqlite3.connect(DB_FILE) as conn:
                        c = conn.cursor()
                        c.execute("SELECT COALESCE(avatar, '') FROM users WHERE username = ?", (current_user,))
                        row = c.fetchone()
                        sender_avatar = row[0] if row else ""

                    save_group_message(group_id, current_user, text, msg_type)
                    payload = {
                        "action": "new_message",
                        "chat_type": "group",
                        "target_id": group_id,
                        "sender": current_user,
                        "text": text,
                        "msg_type": msg_type,
                        "avatar": sender_avatar
                    }
                    for name in member_names:
                        if name in ONLINE_USERS:
                            await send_json(ONLINE_USERS[name], payload)

    except Exception as e:
        logging.warning(f"Connection error: {e}")
    finally:
        if current_user and current_user in ONLINE_USERS:
            del ONLINE_USERS[current_user]
            logging.info(f"{current_user} disconnected.")
            for friend in get_friends(current_user):
                if friend["username"] in ONLINE_USERS:
                    asyncio.create_task(sync_user_dashboard(friend["username"]))

# ----------------- MAIN RUNNER -----------------

async def main():
    init_db()
    port = int(os.environ.get("PORT", 8765))
    async with serve(handle_client, "0.0.0.0", port, max_size=15 * 1024 * 1024):
        logging.info(f"WebSocket chat server running on port {port}")
        await asyncio.get_running_loop().create_future()

if __name__ == "__main__":
    asyncio.run(main())