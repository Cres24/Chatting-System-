# Chatting System

A small realtime chat app built with **Next.js 16**, **Neon Postgres**, **Neon Object Storage**, and **Ably**. The UI is the original plain HTML/CSS frontend; a small JavaScript shim keeps its WebSocket-style action API while calling REST endpoints underneath.

Everything runs on free tiers:

| Service | Free tier used |
| --- | --- |
| Vercel Hobby | Hosting + serverless functions |
| Neon | Postgres database, branching, and object storage |
| Ably | Realtime message delivery (optional) |

## How it fits together

```
Browser (public/*.html + js/*.js)
  │
  ├─ fetch /api/...          ── Next.js route handlers ── Neon Postgres
  │      (auth, friends, groups, messages, uploads)
  │
  ├─ PUT presigned S3 URL    ── Neon Object Storage (private bucket)
  │      (files never pass through the function body limit)
  │
  └─ subscribe to Ably       ── channel `user:{userId}`
         server publishes message / dashboard / notification events
```

- **No native Vercel WebSockets.** Vercel Hobby caps function duration, and separate function instances do not share connections. Ably fans events out to each user's personal channel instead.
- **No base64 in Postgres.** Attachments are written to Neon Object Storage; the database stores a storage key, MIME type, and size.
- **Private by default.** The `uploads` bucket is private. Browsers upload with a short-lived presigned `PUT` URL and read files only through the authenticated `/api/media`, `/api/avatar`, and `/api/group-avatar` routes.
- **Cookie sessions.** `chat_session` is `httpOnly`, `SameSite=Lax`, and valid for 30 days.

## Local development

### 1. Prerequisites

- Node.js 20+ (Node 22 LTS recommended)
- PostgreSQL 14+ locally, or a Neon project
- `createdb` / `psql` available on your `PATH` if using local Postgres

### 2. Install and configure

```bash
npm install
cp .env.example .env.local
```

Edit `.env.local`:

```env
DATABASE_URL=postgresql:///chatdb_dev
DATABASE_URL_UNPOOLED=postgresql:///chatdb_dev
APP_URL=http://localhost:3000
ABLY_API_KEY=
S3_BUCKET=uploads
AWS_ENDPOINT_URL_S3=
AWS_REGION=
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
```

`DATABASE_URL` is the pooled connection used by the app. `DATABASE_URL_UNPOOLED` is the direct connection used by migrations and scripts. With local Postgres, both can be the same URL. The app also accepts `DATABASE_URL_POOLED` as an alias for the pooled URL.

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
- **No S3 configuration:** uploads go to `/api/uploads/dev`, which writes files to `public/uploads/` (gitignored). Local uploads are served through the same authenticated media routes.
- **Neon object storage configured:** uploads go directly from the browser to the private bucket using presigned URLs.

## Neon setup

The checked-in `neon.ts` declares the private `uploads` bucket and a seven-day expiry policy for non-default branches. With the Neon CLI:

```bash
npx -y neon@latest link
npx -y neon@latest deploy
```

`neon deploy` applies the bucket policy and writes the branch credentials to `.env` (the CLI's pull target). Copy the Postgres and object-storage values into `.env.local` for local development:

- `DATABASE_URL` (pooled)
- `DATABASE_URL_UNPOOLED` (direct)
- `S3_BUCKET=uploads`
- `AWS_ENDPOINT_URL_S3`
- `AWS_REGION`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`

Keep `.env`, `.env.local`, and `.neon` out of Git. If Neon writes a new `.env`, make sure `.env.local` does not still point at an older database.

Apply migrations with the direct URL:

```bash
npm run db:migrate
```

Configure bucket CORS after `APP_URL` is set:

```bash
npm run storage:cors
```

This allows `PUT`, `GET`, and `HEAD` from `http://localhost:3000`, `http://localhost:3100`, `APP_URL`, and `https://*.vercel.app`. Rerun it after adding a custom domain that is not under `vercel.app`.

## Importing the old SQLite data

The Python app exported its SQLite data to JSON before removal. To import it into a development database:

```bash
npm run db:import-legacy -- /path/to/chat-legacy-export.json
```

The importer:

- preserves usernames, legacy PBKDF2 hashes, and message timestamps
- maps legacy DM pairs to unified `direct` conversations
- maps legacy groups and members (orphaned usernames are skipped)
- uploads avatars and media to Neon Object Storage when the `AWS_*` variables and `S3_BUCKET` are set
- **skips attachments** with a warning when object storage is not configured

Legacy passwords keep working: hashes are verified at 100,000 PBKDF2-SHA256 iterations and upgraded to 600,000 on the next successful login.

Do not run the importer against the production Neon database unless you intend to replace the demo data with real legacy users.

## Deploying to Vercel (all free)

### 1. Create the Neon project

1. Create a project at <https://neon.tech> (the linked project in this repo uses `aws-ap-southeast-1`).
2. Copy the **pooled** connection string (host contains `-pooler`) and the **direct** connection string.
3. Run the migration against the direct URL from your machine:

   ```bash
   DATABASE_URL_UNPOOLED='postgresql://...direct.../neondb?sslmode=require' npm run db:migrate
   ```

   `db:migrate` reads `.env.local`, but an existing environment variable takes precedence, so the inline override works.

### 2. Create the object-storage bucket

1. Link the project with `npx -y neon@latest link`.
2. Keep the `uploads` bucket in `neon.ts` private and run `npx -y neon@latest deploy`.
3. Copy `AWS_ENDPOINT_URL_S3`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `S3_BUCKET=uploads` into the deployment environment.
4. After the Vercel URL is known, set `APP_URL` and run `npm run storage:cors` locally.

One private bucket is enough for both attachments and avatars; both are streamed through authenticated routes.

### 3. Create the Ably app

1. Create an app at <https://ably.com>.
2. Add an API key with publish/subscribe capability.
3. Set `ABLY_API_KEY` in Vercel.

The server publishes with the full key. Browsers receive a short-lived Ably `TokenRequest` from `/api/realtime/token` that can only subscribe to their own `user:{userId}` channel. Without a key, the app uses polling.

### 4. Configure the Vercel project

Import the repository into Vercel and use these settings:

| Setting | Value |
| --- | --- |
| Framework Preset | **Next.js** |
| Root Directory | repository root (`./`) |
| Build Command | `npm run build` (default) |
| Install Command | `npm install` (default) |
| Output Directory | `.next` (default) |
| Node.js Version | **22.x** |
| Function Region | **Singapore (sin1)** |

Then add these environment variables in **Project → Settings → Environment Variables**:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Neon pooled connection string |
| `DATABASE_URL_UNPOOLED` | Neon direct connection string (migrations/scripts) |
| `APP_URL` | `https://your-project.vercel.app` (or custom domain) |
| `ABLY_API_KEY` | Ably API key (optional) |
| `S3_BUCKET` | `uploads` |
| `AWS_ENDPOINT_URL_S3` | Neon object-storage endpoint |
| `AWS_REGION` | Neon object-storage region |
| `AWS_ACCESS_KEY_ID` | Neon object-storage access key |
| `AWS_SECRET_ACCESS_KEY` | Neon object-storage secret key |

Redeploy after adding variables, then rerun `npm run storage:cors` with the production `APP_URL` if the deployment is not covered by `https://*.vercel.app`.

### Free-tier notes

- Vercel Hobby is for personal, non-commercial projects.
- Neon's free tier scales to zero after inactivity. The first request after idle may take a moment; subsequent requests are normal.
- Neon object storage and bandwidth are finite. Uploads are capped at 10 MB per file by the app.
- Ably's free tier includes a monthly message quota. Realtime is best-effort: the database remains the source of truth, and history always reloads from REST.

## Two developers on one Hobby account

Vercel Hobby allows **one account owner** per project. A second developer cannot be added as a team member on Hobby. The practical setup is:

1. The owner creates the Vercel project and connects the GitHub repository.
2. The second developer is added as a **collaborator on the GitHub repository** (Settings → Collaborators).
3. Both push branches and open pull requests. Vercel creates preview deployments for branches/PRs automatically.
4. Only the owner can change production environment variables and promote a deployment.
5. Keep secrets out of the repo; `.env`, `.env.local`, `.neon`, and `.vercel/` are gitignored. Use `npx vercel env pull` when the owner needs to share non-production values, or set preview-only values in the dashboard.

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
  api/uploads            presigned S3 upload target
  api/uploads/config     upload mode and size limit
  api/uploads/dev        local-development upload fallback
  api/realtime/token     Ably TokenRequest
  api/heartbeat          presence ping (90-second online window)
db/migrations/           SQL schema (authoritative)
lib/                     auth, chat queries, storage, Ably, env, validation
public/                  original HTML/CSS UI + compatibility shim
  js/socket-shim.js      WebSocket-style API over REST
  js/realtime.js         Ably subscription + polling fallback + heartbeat
  js/upload.js           presigned S3 uploads + local dev fallback
scripts/                 migrate, seed, legacy import, S3 CORS, vendor build
neon.ts                  Neon branch policy and private uploads bucket
```

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Build the Ably vendor bundle and start Next.js in development |
| `npm run build` | Production build |
| `npm run start` | Start the production server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run vendor` | Copy the Ably browser bundle into `public/vendor/` |
| `npm run db:migrate` | Apply SQL migrations in `db/migrations/` |
| `npm run db:seed` | Insert demo users and conversations |
| `npm run db:import-legacy -- <file>` | Import the old SQLite JSON export |
| `npm run storage:cors` | Apply CORS rules to the Neon object-storage bucket |

## Security notes

- Passwords use PBKDF2-SHA256 with per-user salts; new hashes and upgrades use 600,000 iterations.
- Session cookies are `httpOnly`, `SameSite=Lax`, and `Secure` in production.
- Mutating requests are origin-checked in addition to `SameSite=Lax`.
- Media access checks conversation membership; non-members receive `403`.
- Uploads use short-lived presigned `PUT` URLs scoped to the current user and MIME type. The server verifies each object with `HeadObject` before attaching it to a message, avatar, or group.
- The old `chat.db` has been removed from the working tree. It previously contained password hashes and private messages; if this repository was ever public, purge it from Git history (for example with `git filter-repo` or BFG) before publishing.
