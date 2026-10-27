import asyncio
import json
import logging
import os
import hashlib
import secrets
import psycopg2
from psycopg2.extras import RealDictCursor
from websockets.asyncio.server import serve

logging.basicConfig(level=logging.INFO)

ONLINE_USERS = {}  # username -> websocket connection

DB_CONFIG = {
    "host": os.environ.get("PGHOST", "localhost"),
    "port": os.environ.get("PGPORT", "5432"),
    "dbname": os.environ.get("PGDATABASE", "chatdb"),
    "user": os.environ.get("PGUSER", "postgres"),
    "password": os.environ.get("PGPASSWORD", "postgres"),
}


def get_conn():
    return psycopg2.connect(**DB_CONFIG)

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
    with get_conn() as conn:
        c = conn.cursor()
        c.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                full_name TEXT NOT NULL,
                username VARCHAR(50) UNIQUE NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                password_salt TEXT NOT NULL
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
            CREATE TABLE IF NOT EXISTS friend_requests (
                id SERIAL PRIMARY KEY,
                from_user VARCHAR(50) NOT NULL,
                to_user VARCHAR(50) NOT NULL,
                status VARCHAR(20) DEFAULT 'pending'
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS direct_messages (
                id SERIAL PRIMARY KEY,
                sender VARCHAR(50) NOT NULL,
                receiver VARCHAR(50) NOT NULL,
                text TEXT NOT NULL,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS groups (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                creator VARCHAR(50) NOT NULL
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS group_members (
                group_id INTEGER,
                username VARCHAR(50) NOT NULL,
                PRIMARY KEY (group_id, username)
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS group_messages (
                id SERIAL PRIMARY KEY,
                group_id INTEGER NOT NULL,
                sender VARCHAR(50) NOT NULL,
                text TEXT NOT NULL,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.commit()

def register_user(full_name: str, username: str, email: str, password: str):
    p_hash, salt = hash_password(password)
    try:
        with get_conn() as conn:
            c = conn.cursor()
            c.execute("""
                INSERT INTO users (full_name, username, email, password_hash, password_salt)
                VALUES (%s, %s, %s, %s, %s)
            """, (full_name, username, email.lower(), p_hash, salt))
            conn.commit()
            return True, "Registration successful! You can now log in."
    except psycopg2.IntegrityError as e:
        err_msg = str(e).lower()
        if "username" in err_msg:
            return False, "Username is already taken."
        elif "email" in err_msg:
            return False, "Email is already registered."
        return False, "Account already exists."

def authenticate_user(identifier: str, password: str):
    with get_conn() as conn:
        c = conn.cursor()
        c.execute("""
            SELECT full_name, username, email, password_hash, password_salt
            FROM users
            WHERE username = %s OR email = %s
        """, (identifier, identifier.lower()))
        user = c.fetchone()
        if not user:
            return None, "Invalid username or password."
        
        full_name, username, email, p_hash, salt = user
        if verify_password(p_hash, salt, password):
            return {"full_name": full_name, "username": username, "email": email}, "Success"
        return None, "Invalid username or password."

def get_friends(username: str):
    with get_conn() as conn:
        c = conn.cursor()
        c.execute("""
            SELECT u2.username, u2.full_name FROM users u1
            JOIN friends f ON u1.id = f.user_id
            JOIN users u2 ON f.friend_id = u2.id
            WHERE u1.username = %s
        """, (username,))
        return [{"username": row[0], "full_name": row[1]} for row in c.fetchall()]

def get_pending_requests(username: str):
    with get_conn() as conn:
        c = conn.cursor()
        c.execute("SELECT from_user FROM friend_requests WHERE to_user = %s AND status = 'pending'", (username,))
        return [row[0] for row in c.fetchall()]

def add_friend_request(from_user: str, to_user: str):
    if from_user == to_user:
        return False, "You cannot add yourself."
    with get_conn() as conn:
        c = conn.cursor()
        c.execute("SELECT id FROM users WHERE username = %s", (to_user,))
        if not c.fetchone():
            return False, "User does not exist."
        
        friends = [f["username"] for f in get_friends(from_user)]
        if to_user in friends:
            return False, "Already friends."
        
        c.execute("SELECT id FROM friend_requests WHERE from_user = %s AND to_user = %s AND status = 'pending'", (from_user, to_user))
        if c.fetchone():
            return False, "Request already sent."
        c.execute("INSERT INTO friend_requests (from_user, to_user) VALUES (%s, %s)", (from_user, to_user))
        conn.commit()
        return True, "Request sent."

def accept_request(from_user: str, to_user: str):
    with get_conn() as conn:
        c = conn.cursor()
        c.execute("SELECT id FROM users WHERE username = %s", (from_user,))
        u1_row = c.fetchone()
        c.execute("SELECT id FROM users WHERE username = %s", (to_user,))
        u2_row = c.fetchone()
        if not u1_row or not u2_row:
            return
        u1 = u1_row[0]
        u2 = u2_row[0]
        c.execute("INSERT INTO friends (user_id, friend_id) VALUES (%s, %s) ON CONFLICT DO NOTHING", (u1, u2))
        c.execute("INSERT INTO friends (user_id, friend_id) VALUES (%s, %s) ON CONFLICT DO NOTHING", (u2, u1))
        c.execute("DELETE FROM friend_requests WHERE from_user = %s AND to_user = %s", (from_user, to_user))
        conn.commit()

def create_group(name: str, creator: str, members: list[str]) -> int:
    with get_conn() as conn:
        c = conn.cursor()
        c.execute("INSERT INTO groups (name, creator) VALUES (%s, %s) RETURNING id", (name, creator))
        group_id = c.fetchone()[0]
        all_members = set(members + [creator])
        for member in all_members:
            c.execute("INSERT INTO group_members (group_id, username) VALUES (%s, %s) ON CONFLICT DO NOTHING", (group_id, member))
        conn.commit()
        return group_id

def get_user_groups(username: str):
    with get_conn() as conn:
        c = conn.cursor()
        c.execute("""
            SELECT g.id, g.name FROM groups g
            JOIN group_members gm ON g.id = gm.group_id
            WHERE gm.username = %s
        """, (username,))
        return [{"id": row[0], "name": row[1]} for row in c.fetchall()]

def get_group_members_with_status(group_id: int):
    with sqlite3.connect(DB_FILE) as conn:
        c = conn.cursor()
        c.execute("""
            SELECT gm.username, u.full_name 
            FROM group_members gm
            LEFT JOIN users u ON gm.username = u.username
            WHERE gm.group_id = ?
        """, (group_id,))
        rows = c.fetchall()
        return [
            {
                "username": row[0],
                "full_name": row[1] or row[0],
                "online": row[0] in ONLINE_USERS
            }
            for row in rows
        ]
def save_direct_message(sender: str, receiver: str, text: str):
    with get_conn() as conn:
        c = conn.cursor()
        c.execute("INSERT INTO direct_messages (sender, receiver, text) VALUES (%s, %s, %s)", (sender, receiver, text))
        conn.commit()

def save_group_message(group_id: int, sender: str, text: str):
    with get_conn() as conn:
        c = conn.cursor()
        c.execute("INSERT INTO group_messages (group_id, sender, text) VALUES (%s, %s, %s)", (group_id, sender, text))
        conn.commit()

def get_direct_history(u1: str, u2: str):
    with get_conn() as conn:
        c = conn.cursor()
        c.execute("""
            SELECT sender, text FROM direct_messages
            WHERE (sender = %s AND receiver = %s) OR (sender = %s AND receiver = %s)
            ORDER BY timestamp ASC LIMIT 50
        """, (u1, u2, u2, u1))
        return [{"sender": row[0], "text": row[1]} for row in c.fetchall()]

def get_group_history(group_id: int):
    with get_conn() as conn:
        c = conn.cursor()
        c.execute("""
            SELECT sender, text FROM group_messages
            WHERE group_id = %s
            ORDER BY timestamp ASC LIMIT 50
        """, (group_id,))
        return [{"sender": row[0], "text": row[1]} for row in c.fetchall()]

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
        {"username": f["username"], "full_name": f["full_name"], "online": f["username"] in ONLINE_USERS}
        for f in friends
    ]
    pending = get_pending_requests(username)
    groups = get_user_groups(username)

    await send_json(ws, {
        "action": "dashboard_sync",
        "friends": friends_status,
        "requests": pending,
        "groups": groups
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
                    logging.info(f"{current_user} resumed session on chat.html.")
                    await sync_user_dashboard(current_user)
                    for friend in get_friends(current_user):
                        if friend["username"] in ONLINE_USERS:
                            await sync_user_dashboard(friend["username"])

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
                if not text:
                    continue

                if chat_type == "direct":
                    save_direct_message(current_user, target_id, text)
                    payload = {
                        "action": "new_message",
                        "chat_type": "direct",
                        "target_id": current_user,
                        "sender": current_user,
                        "text": text
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

                    save_group_message(group_id, current_user, text)
                    payload = {
                        "action": "new_message",
                        "chat_type": "group",
                        "target_id": group_id,
                        "sender": current_user,
                        "text": text
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
    # Bind to 0.0.0.0 to prevent localhost / 127.0.0.1 IP mismatches on Windows
    async with serve(handle_client, "0.0.0.0", 8765):
        logging.info("WebSocket chat server with Auth running on port 8765")
        await asyncio.get_running_loop().create_future()

if __name__ == "__main__":
    asyncio.run(main())