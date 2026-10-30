# Chatting System

A small realtime chat app built with **Next.js 16**, **Neon Postgres**, **Vercel Blob**, and **Ably**. The UI is the original plain HTML/CSS frontend; a small JavaScript shim keeps its WebSocket-style action API while calling REST endpoints underneath.

Everything runs on free tiers:

| Service | Free tier used |
| --- | --- |
| Vercel Hobby | Hosting + serverless functions |
| Neon | Postgres database |
| Vercel Blob | Attachments and avatars |
| Ably | Realtime message delivery |

## How it fits together

```
Browser (public/*.html + js/*.js)
  │
  ├─ fetch /api/...          ── Next.js route handlers ── Neon Postgres
  │      (auth, friends, groups, messages, uploads)
  │
  ├─ upload Vercel Blob      ── token from /api/uploads
  │      (files never pass through the function body limit)
  │
  └─ subscribe to Ably       ── channel `user:{userId}`
         server publishes message / dashboard / notification events
```

- **No native Vercel WebSockets.** Vercel Hobby caps function duration, and separate function instances do not share connections. Ably fans events out to each user's personal channel instead.
- **No base64 in Postgres.** Attachments are written to Blob; the database stores a storage key, MIME type, and size.
- **Private by default.** With a private Blob store, files are only readable through the authenticated `/api/media`, `/api/avatar`, and `/api/group-avatar` routes.
- **Cookie sessions.** `chat_session` is `httpOnly`, `SameSite=Lax`, and valid for 30 days.

## Local development

### 1. Prerequisites

- Node.js 20+
- A local PostgreSQL 14+ server
- `createdb` / `psql` available on your `PATH`

### 2. Install and configure

```bash
npm install
cp .env.example .env.local
```

Edit `.env.local`:

```env
DATABASE_URL=postgresql:///chatdb_dev
APP_URL=http://localhost:3000
ABLY_API_KEY=
BLOB_READ_WRITE_TOKEN=
BLOB_ACCESS=private
```

Create the database and apply the schema:

```bash
createdb chatdb_dev
npm run db:migrate
```

### 3. Seed demo users (optional)

```bash
npm run db:seed
```

This creates `aarav`, `bina`, and `chetan` with password `chatdemo123`, plus a small friendship graph, a group, and some messages.

### 4. Run

```bash
npm run dev
```

Open <http://localhost:3000>. The root page redirects to `/login.html` or `/chat.html` based on the session cookie.

### Local fallbacks

- **No `ABLY_API_KEY`:** the browser polls `/api/bootstrap` and the active conversation every 12 seconds. Everything still works, just without push updates.
- **No `BLOB_READ_WRITE_TOKEN`:** uploads go to `/api/uploads/dev`, which writes files to `public/uploads/` (gitignored). Local uploads are served through the same authenticated media routes.

## Importing the old SQLite data

The Python app exported its SQLite data to JSON before removal. To import it:

```bash
npm run db:import-legacy -- /path/to/chat-legacy-export.json
```

The importer:

- preserves usernames, legacy PBKDF2 hashes, and message timestamps
- maps legacy DM pairs to unified `direct` conversations
- maps legacy groups and members (orphaned usernames are skipped)
- uploads avatars and media to Blob when `BLOB_READ_WRITE_TOKEN` is set
- **skips attachments** with a warning when Blob is not configured

Legacy passwords keep working: hashes are verified at 100,000 PBKDF2-SHA256 iterations and upgraded to 600,000 on the next successful login.

## Deploying to Vercel (all free)

### 1. Create the Neon database

1. Create a project at <https://neon.tech>.
2. Copy the **pooled** connection string (host contains `-pooler`).
3. Run the migration against it from your machine:

   ```bash
   DATABASE_URL='postgresql://...-pooler.../neondb?sslmode=require' npm run db:migrate
   ```

   `db:migrate` reads `.env.local`, but an existing `DATABASE_URL` environment variable takes precedence, so the inline override works.

### 2. Create the Blob store

1. In the Vercel dashboard, open **Storage → Blob** and create a store.
2. Choose **Private** access (recommended).
3. Connect the store to the project. Vercel injects `BLOB_READ_WRITE_TOKEN`.
4. If you instead create a **Public** store, set `BLOB_ACCESS=public`. Message media will still be proxied, but the underlying Blob URLs will also be publicly reachable.

One private store is enough for both attachments and avatars — both are streamed through authenticated routes.

### 3. Create the Ably app

1. Create an app at <https://ably.com>.
2. Add an API key with publish/subscribe capability.
3. Set `ABLY_API_KEY` in Vercel.

The server publishes with the full key. Browsers receive a short-lived Ably `TokenRequest` from `/api/realtime/token` that can only subscribe to their own `user:{userId}` channel.

### 4. Deploy

```bash
npx vercel
```

Set these environment variables in **Project → Settings → Environment Variables**:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Neon pooled connection string |
| `APP_URL` | `https://your-project.vercel.app` (or custom domain) |
| `ABLY_API_KEY` | Ably API key |
| `BLOB_READ_WRITE_TOKEN` | injected by the Blob integration |
| `BLOB_ACCESS` | `private` (or `public` if using a public store) |

Redeploy after adding variables.

### Free-tier notes

- Vercel Hobby is for personal, non-commercial projects.
- Neon's free tier scales to zero after inactivity. The first request after idle may take a moment; subsequent requests are normal.
- Ably's free tier includes a monthly message quota. Realtime is best-effort: the database remains the source of truth, and history always reloads from REST.
- Vercel Blob free storage/bandwidth is finite. Uploads are capped at 10 MB per file by the app.

## Two developers on one Hobby account

Vercel Hobby allows **one account owner** per project. A second developer cannot be added as a team member on Hobby. The practical setup is:

1. The owner creates the Vercel project and connects the GitHub repository.
2. The second developer is added as a **collaborator on the GitHub repository** (Settings → Collaborators).
3. Both push branches and open pull requests. Vercel creates preview deployments for branches/PRs automatically.
4. Only the owner can change production environment variables and promote a deployment.
5. Keep secrets out of the repo; `.env.local` and `.vercel/` are gitignored. Use `npx vercel env pull` when the owner needs to share non-production values, or set preview-only values in the dashboard.

This keeps the project on the free Hobby plan while still giving both developers preview URLs for testing.

## Project layout

```
app/                     Next.js App Router + route handlers
  api/auth/*             register, login, logout, me
  api/bootstrap          dashboard snapshot (friends, requests, groups, blocked)
  api/dm/[username]/*    direct conversation history + send
  api/groups/*           group CRUD, members, promote, leave, history + send
  api/media/[id]         authenticated attachment stream
  api/avatar/[id]        authenticated user avatar stream
  api/group-avatar/[id]  authenticated group avatar stream
  api/uploads/*          Blob client-token issuance + local dev uploader
  api/realtime/token     Ably TokenRequest
  api/heartbeat          presence ping (90-second online window)
db/migrations/           SQL schema (authoritative)
lib/                     auth, chat queries, storage, Ably, env, validation
public/                  original HTML/CSS UI + compatibility shim
  js/socket-shim.js      WebSocket-style API over REST
  js/realtime.js         Ably subscription + polling fallback + heartbeat
  js/upload.js           Blob client uploads + local dev fallback
scripts/                 migrate, seed, legacy import, vendor build
```

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Build vendor bundles and start Next.js in development |
| `npm run build` | Production build |
| `npm run start` | Start the production server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run vendor` | Copy Ably and bundle the Blob browser client into `public/vendor/` |
| `npm run db:migrate` | Apply SQL migrations in `db/migrations/` |
| `npm run db:seed` | Insert demo users and conversations |
| `npm run db:import-legacy -- <file>` | Import the old SQLite JSON export |

## Security notes

- Passwords use PBKDF2-SHA256 with per-user salts; new hashes and upgrades use 600,000 iterations.
- Session cookies are `httpOnly`, `SameSite=Lax`, and `Secure` in production.
- Mutating requests are origin-checked in addition to `SameSite=Lax`.
- Media access checks conversation membership; non-members receive `403`.
- The old `chat.db` has been removed from the working tree. It previously contained password hashes and private messages; if this repository was ever public, purge it from Git history (for example with `git filter-repo` or BFG) before publishing.
