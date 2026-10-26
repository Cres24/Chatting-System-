import asyncio
import json
import logging
import sqlite3
from websockets.asyncio.server import serve

logging.basicConfig(level=logging.INFO)

DB_FILE = "chat.db"

# In-memory mapping: username -> websocket connection
ONLINE_USERS = {}

# ----------------- DATABASE HELPERS -----------------

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
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sender TEXT NOT NULL,
                receiver TEXT NOT NULL,
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

        # Check existing friendship
        friends = get_friends(from_user)
        if to_user in friends:
            return False, "Already friends."

        # Check if already requested
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

        # Add bidirectional friendship
        c.execute("INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)", (u1, u2))
        c.execute("INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)", (u2, u1))
        # Remove request
        c.execute("DELETE FROM friend_requests WHERE from_user = ? AND to_user = ?", (from_user, to_user))
        conn.commit()

def save_message(sender: str, receiver: str, text: str):
    with sqlite3.connect(DB_FILE) as conn:
        c = conn.cursor()
        c.execute("INSERT INTO messages (sender, receiver, text) VALUES (?, ?, ?)", (sender, receiver, text))
        conn.commit()

def get_chat_history(user1: str, user2: str):
    with sqlite3.connect(DB_FILE) as conn:
        c = conn.cursor()
        c.execute("""
            SELECT sender, text FROM messages
            WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?)
            ORDER BY timestamp ASC LIMIT 50
        """, (user1, user2, user2, user1))
        return [{"sender": row[0], "text": row[1]} for row in c.fetchall()]

# ----------------- NOTIFICATION HELPERS -----------------

async def send_json(ws, data: dict):
    if ws:
        await ws.send(json.dumps(data))

async def sync_user_dashboard(username: str):
    ws = ONLINE_USERS.get(username)
    if not ws:
        return
    friends = get_friends(username)
    friends_status = [
        {"username": f, "online": f in ONLINE_USERS} for f in friends
    ]
    pending = get_pending_requests(username)
    await send_json(ws, {
        "action": "dashboard_sync",
        "friends": friends_status,
        "requests": pending
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

                # Notify friends that user is online
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

            elif action == "load_chat":
                friend = data.get("friend")
                history = get_chat_history(current_user, friend)
                await send_json(websocket, {
                    "action": "chat_history",
                    "friend": friend,
                    "history": history
                })

            elif action == "send_direct_message":
                recipient = data.get("recipient")
                text = data.get("text", "").strip()
                if not text or not recipient:
                    continue

                # Verify they are friends before routing
                if recipient not in get_friends(current_user):
                    await send_json(websocket, {"action": "alert", "text": "You can only message friends."})
                    continue

                save_message(current_user, recipient, text)

                payload = {
                    "action": "new_direct_message",
                    "sender": current_user,
                    "recipient": recipient,
                    "text": text
                }
                # Send to recipient if online
                if recipient in ONLINE_USERS:
                    await send_json(ONLINE_USERS[recipient], payload)
                # Echo back to sender
                await send_json(websocket, payload)

    except Exception as e:
        logging.warning(f"Connection error: {e}")
    finally:
        if current_user and current_user in ONLINE_USERS:
            del ONLINE_USERS[current_user]
            logging.info(f"{current_user} disconnected.")
            # Notify friends that user is offline
            for friend in get_friends(current_user):
                if friend in ONLINE_USERS:
                    asyncio.create_task(sync_user_dashboard(friend))

async def main():
    init_db()
    async with serve(handle_client, "127.0.0.1", 8765):
        logging.info("Server running with Friends System on ws://127.0.0.1:8765")
        await asyncio.get_running_loop().create_future()

if __name__ == "__main__":
    asyncio.run(main())