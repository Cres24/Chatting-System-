import asyncio
import json
import logging
import sqlite3
from websockets.asyncio.server import serve

logging.basicConfig(level=logging.INFO)

DB_FILE = "chat.db"
ONLINE_USERS = {}  # username -> websocket

# ----------------- DATABASE SETUP & QUERIES -----------------

def init_db():
    with sqlite3.connect(DB_FILE) as conn:
        c = conn.cursor()
        c.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL
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
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)
        # Group tables
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
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.commit()

def get_or_create_user(username: str):
    with sqlite3.connect(DB_FILE) as conn:
        c = conn.cursor()
        c.execute("INSERT OR IGNORE INTO users (username) VALUES (?)", (username,))
        conn.commit()

def get_friends(username: str):
    with sqlite3.connect(DB_FILE) as conn:
        c = conn.cursor()
        c.execute("""
            SELECT u2.username FROM users u1
            JOIN friends f ON u1.id = f.user_id
            JOIN users u2 ON f.friend_id = u2.id
            WHERE u1.username = ?
        """, (username,))
        return [row[0] for row in c.fetchall()]

def get_pending_requests(username: str):
    with sqlite3.connect(DB_FILE) as conn:
        c = conn.cursor()
        c.execute("SELECT from_user FROM friend_requests WHERE to_user = ? AND status = 'pending'", (username,))
        return [row[0] for row in c.fetchall()]

def add_friend_request(from_user: str, to_user: str):
    if from_user == to_user:
        return False, "You cannot add yourself."
    with sqlite3.connect(DB_FILE) as conn:
        c = conn.cursor()
        c.execute("SELECT id FROM users WHERE username = ?", (to_user,))
        if not c.fetchone():
            return False, "User does not exist."
        if to_user in get_friends(from_user):
            return False, "Already friends."
        c.execute("SELECT id FROM friend_requests WHERE from_user = ? AND to_user = ? AND status = 'pending'", (from_user, to_user))
        if c.fetchone():
            return False, "Request already sent."
        c.execute("INSERT INTO friend_requests (from_user, to_user) VALUES (?, ?)", (from_user, to_user))
        conn.commit()
        return True, "Request sent."

def accept_request(from_user: str, to_user: str):
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

# --- Group Helpers ---

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

def get_group_members(group_id: int):
    with sqlite3.connect(DB_FILE) as conn:
        c = conn.cursor()
        c.execute("SELECT username FROM group_members WHERE group_id = ?", (group_id,))
        return [row[0] for row in c.fetchall()]

def save_direct_message(sender: str, receiver: str, text: str):
    with sqlite3.connect(DB_FILE) as conn:
        c = conn.cursor()
        c.execute("INSERT INTO direct_messages (sender, receiver, text) VALUES (?, ?, ?)", (sender, receiver, text))
        conn.commit()

def save_group_message(group_id: int, sender: str, text: str):
    with sqlite3.connect(DB_FILE) as conn:
        c = conn.cursor()
        c.execute("INSERT INTO group_messages (group_id, sender, text) VALUES (?, ?, ?)", (group_id, sender, text))
        conn.commit()

def get_direct_history(u1: str, u2: str):
    with sqlite3.connect(DB_FILE) as conn:
        c = conn.cursor()
        c.execute("""
            SELECT sender, text FROM direct_messages
            WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?)
            ORDER BY timestamp ASC LIMIT 50
        """, (u1, u2, u2, u1))
        return [{"sender": row[0], "text": row[1]} for row in c.fetchall()]

def get_group_history(group_id: int):
    with sqlite3.connect(DB_FILE) as conn:
        c = conn.cursor()
        c.execute("""
            SELECT sender, text FROM group_messages
            WHERE group_id = ?
            ORDER BY timestamp ASC LIMIT 50
        """, (group_id,))
        return [{"sender": row[0], "text": row[1]} for row in c.fetchall()]

# ----------------- BROADCAST & SYNC -----------------

async def send_json(ws, data: dict):
    if ws:
        await ws.send(json.dumps(data))

async def sync_user_dashboard(username: str):
    ws = ONLINE_USERS.get(username)
    if not ws:
        return
    friends = get_friends(username)
    friends_status = [{"username": f, "online": f in ONLINE_USERS} for f in friends]
    pending = get_pending_requests(username)
    groups = get_user_groups(username)

    await send_json(ws, {
        "action": "dashboard_sync",
        "friends": friends_status,
        "requests": pending,
        "groups": groups
    })

# ----------------- WEBSOCKET HANDLER -----------------

async def handle_client(websocket):
    current_user = None
    try:
        async for raw_message in websocket:
            data = json.loads(raw_message)
            action = data.get("action")

            if action == "login":
                current_user = data.get("username", "").strip()
                if not current_user:
                    continue
                get_or_create_user(current_user)
                ONLINE_USERS[current_user] = websocket
                logging.info(f"{current_user} connected.")
                await sync_user_dashboard(current_user)

                for friend in get_friends(current_user):
                    if friend in ONLINE_USERS:
                        await sync_user_dashboard(friend)

            elif action == "send_friend_request":
                target = data.get("to_user", "").strip()
                success, msg = add_friend_request(current_user, target)
                await send_json(websocket, {"action": "alert", "text": msg})
                if success and target in ONLINE_USERS:
                    await sync_user_dashboard(target)

            elif action == "accept_friend_request":
                from_user = data.get("from_user")
                accept_request(from_user, current_user)
                await sync_user_dashboard(current_user)
                if from_user in ONLINE_USERS:
                    await sync_user_dashboard(from_user)

            elif action == "create_group":
                name = data.get("name", "").strip()
                members = data.get("members", [])
                if not name:
                    await send_json(websocket, {"action": "alert", "text": "Group name is required."})
                    continue

                group_id = create_group(name, current_user, members)
                # Refresh dashboards for all online group members
                for member in get_group_members(group_id):
                    if member in ONLINE_USERS:
                        await sync_user_dashboard(member)

            elif action == "load_chat":
                chat_type = data.get("chat_type")  # "direct" or "group"
                target_id = data.get("target_id")

                if chat_type == "direct":
                    history = get_direct_history(current_user, target_id)
                else:
                    history = get_group_history(int(target_id))

                await send_json(websocket, {
                    "action": "chat_history",
                    "chat_type": chat_type,
                    "target_id": target_id,
                    "history": history
                })

            elif action == "send_message":
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
                    members = get_group_members(group_id)
                    if current_user not in members:
                        continue

                    save_group_message(group_id, current_user, text)
                    payload = {
                        "action": "new_message",
                        "chat_type": "group",
                        "target_id": group_id,
                        "sender": current_user,
                        "text": text
                    }
                    for member in members:
                        if member in ONLINE_USERS:
                            await send_json(ONLINE_USERS[member], payload)

    except Exception as e:
        logging.warning(f"Connection error: {e}")
    finally:
        if current_user and current_user in ONLINE_USERS:
            del ONLINE_USERS[current_user]
            logging.info(f"{current_user} disconnected.")
            for friend in get_friends(current_user):
                if friend in ONLINE_USERS:
                    asyncio.create_task(sync_user_dashboard(friend))

async def main():
    init_db()
    async with serve(handle_client, "127.0.0.1", 8765):
        logging.info("WebSocket Chat & Groups server running on ws://127.0.0.1:8765")
        await asyncio.get_running_loop().create_future()

if __name__ == "__main__":
    asyncio.run(main())