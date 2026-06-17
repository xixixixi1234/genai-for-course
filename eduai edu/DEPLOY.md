# Deployment Guide

Three deployment paths, from easiest to most technical. Pick whichever fits how comfortable you are with servers.

---

## Before You Start

You'll need:
- A **Gemini API key** — free at https://aistudio.google.com/apikey
- An **admin password** you choose for the instructor console

Keep both ready; you'll plug them into environment variables in any deployment method.

---

## Option A — Railway (easiest, ~5 minutes, free tier available)

Railway hosts the app, gives it a public URL, and handles HTTPS for you. No server admin needed.

### Steps

1. **Put your code on GitHub.**
   - Sign up at github.com if you haven't
   - Create a new repo (e.g. `studio`)
   - Upload all files from this project to that repo (drag-and-drop in the GitHub web UI works)
   - **Do not** include `.env`, `node_modules/`, or `server/data.db` — the included `.gitignore` already excludes them

2. **Sign up at railway.app** with your GitHub account.

3. **Create a new project** → "Deploy from GitHub repo" → select your `studio` repo.
   Railway auto-detects Node.js and starts building.

4. **Add environment variables.**
   In the project, go to **Variables** and add:
   ```
   GEMINI_API_KEY = <your Gemini key>
   ADMIN_PASSWORD = <a password you choose>
   GEMINI_MODEL = gemini-2.5-flash
   ```
   (Don't add `PORT` — Railway sets it automatically.)

5. **Add a persistent volume** so the database and uploads survive restarts.
   - Settings → Volumes → New Volume
   - Mount path: `/app/server`
   - Size: 1 GB is plenty

6. **Generate a public URL.**
   Settings → Networking → "Generate Domain". You'll get something like `studio-production-abcd.up.railway.app`.

7. **Done.** Open the URL:
   - Students: `https://<your-url>/`
   - Instructor: `https://<your-url>/admin`

**Cost.** Railway's free tier gives ~$5/month of credit; this app uses well under that for a class-sized group. After the trial you pay-as-you-go (typically a few dollars a month).

---

## Option B — Your own VPS (Ubuntu server, ~20 minutes, ~$5/month)

If you have or want a Linux VPS (DigitalOcean, Hetzner, Vultr, AWS Lightsail, etc.), this gives you full control. Below assumes Ubuntu 22.04 or 24.04.

### 1. SSH into your server

```bash
ssh root@your.server.ip
```

### 2. Install Node.js 20+

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs build-essential
node --version  # should print v20.x or higher
```

### 3. Upload the project

Easiest way — install git and clone from GitHub:

```bash
apt install -y git
cd /opt
git clone https://github.com/<your-username>/studio.git
cd studio
```

Or use `scp` from your laptop:

```bash
# Run this on your local machine
scp -r ./eduai root@your.server.ip:/opt/studio
```

### 4. Install dependencies and configure

```bash
cd /opt/studio
npm install
cp .env.example .env
nano .env   # fill in GEMINI_API_KEY and ADMIN_PASSWORD, save with Ctrl+O, exit Ctrl+X
```

### 5. Test that it runs

```bash
npm start
```

Open `http://your.server.ip:3000/` in a browser — you should see the login page. Press Ctrl+C to stop.

### 6. Run it as a service with PM2

PM2 keeps the app running, restarts it on crash, and on server reboot.

```bash
npm install -g pm2
pm2 start server/index.js --name studio
pm2 save
pm2 startup    # follow the printed instruction (one command to copy-paste)
```

Check status:
```bash
pm2 status
pm2 logs studio
```

### 7. Set up a domain + HTTPS with Caddy (recommended)

If you have a domain name, point its DNS A record to your server's IP, then:

```bash
apt install -y caddy
nano /etc/caddy/Caddyfile
```

Paste this (replace with your domain):
```
studio.yourdomain.com {
    reverse_proxy localhost:3000
}
```

Then:
```bash
systemctl reload caddy
```

Caddy gets a free Let's Encrypt HTTPS certificate automatically. Open `https://studio.yourdomain.com` — done.

### 8. (Optional) Firewall

```bash
ufw allow 22
ufw allow 80
ufw allow 443
ufw enable
```

---

## Option C — Docker (anywhere you can run Docker)

The included `Dockerfile` makes it portable.

### Build and run locally

```bash
docker build -t studio .
docker run -d \
  --name studio \
  -p 3000:3000 \
  -e GEMINI_API_KEY=your_key_here \
  -e ADMIN_PASSWORD=your_password_here \
  -e GEMINI_MODEL=gemini-2.5-flash \
  -v $(pwd)/data:/app/server \
  studio
```

Open http://localhost:3000.

### docker-compose alternative

Create `docker-compose.yml`:
```yaml
services:
  studio:
    build: .
    ports:
      - "3000:3000"
    environment:
      GEMINI_API_KEY: your_key
      ADMIN_PASSWORD: your_password
      GEMINI_MODEL: gemini-2.5-flash
    volumes:
      - ./data:/app/server
    restart: unless-stopped
```

Then: `docker compose up -d`

---

## Backups

The two things you want to back up:
- `server/data.db` — all students, messages, cases (the actual SQLite file)
- `server/uploads/` — any case attachments

A simple cron job on a VPS:
```bash
# Run nightly at 2am
0 2 * * * cp /opt/studio/server/data.db /opt/studio/backups/data-$(date +\%Y\%m\%d).db
```

For Railway, you can download `data.db` from the volume browser anytime.

---

## Troubleshooting

**"GEMINI_API_KEY is not set"** in console
Your `.env` file isn't being read. Check it's in the project root and not in a subfolder.

**`better-sqlite3` build error on `npm install`**
You need build tools. On Ubuntu: `apt install build-essential python3`. On Mac: `xcode-select --install`. The app falls back to Node's built-in `node:sqlite` if better-sqlite3 fails to compile, so it should still work as long as you're on Node 22+.

**Students can log in but chat returns "Gemini API call failed"**
Three usual causes:
1. Your `GEMINI_API_KEY` is wrong or expired — regenerate at https://aistudio.google.com/apikey
2. The model name in `GEMINI_MODEL` is wrong — use exactly `gemini-2.5-flash` or `gemini-2.5-pro`
3. You've hit Gemini's free rate limit — wait a minute or upgrade your Google AI Studio plan

**Admin login fails**
Make sure `ADMIN_PASSWORD` in `.env` matches what you type. If you change `.env`, restart the server (`pm2 restart studio` or `docker restart studio` or Railway redeploys automatically).

**Port already in use**
Change `PORT=3000` in `.env` to something else like `3001`.

**Data lost after restart on Railway / Docker**
You forgot to attach a persistent volume to `/app/server`. The SQLite database lives there.

---

## Sharing with Students

Once deployed, just share the root URL (e.g. `https://studio.yourdomain.com/`).

Students:
1. Type their name
2. Pick a case or use Free Conversation
3. Chat away

Keep the `/admin` URL to yourself. Students don't need to know it.
