# The Studio

A collaborative learning platform where students discuss instructor-uploaded cases with AI (powered by Google Gemini).

## What it does

**Student app (`/`)**
- Students enter their name to begin — no signup, no password
- Browse cases uploaded by the instructor
- Discuss each case with the AI, which is prompted to *guide thinking* rather than just hand over answers
- Free conversation mode for general questions

**Instructor panel (`/admin`)**
- Password-protected
- Overview: total students, total prompts, total messages, total cases
- Case engagement: how many students discussed each case, message volume per case
- Students table: time on site, prompt count, first seen, last active
- Click any student to see their full conversation history, with timestamps and case tags
- Upload cases with title, description, full text, and optional file attachment (PDF, image, etc.)

## Quick start (local)

```bash
tar -xzf studio.tar.gz
cd eduai
cp .env.example .env
# Edit .env: put in your GEMINI_API_KEY and pick an ADMIN_PASSWORD
npm install
npm start
```

Open:
- Student: `http://localhost:3000/`
- Instructor: `http://localhost:3000/admin`

Get a Gemini API key (free tier is generous) at https://aistudio.google.com/apikey

---

## Deploying to a server

You have three good options. Pick whichever you're most comfortable with.

### Option A — VPS (DigitalOcean, Linode, Hetzner, AWS EC2, etc.)

The simplest path if you have a Linux server.

```bash
# 1. SSH in and install Node 20
ssh user@your-server
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs build-essential

# 2. From your laptop, upload the project
scp studio.tar.gz user@your-server:~/

# 3. Back on the server
tar -xzf studio.tar.gz
cd eduai
cp .env.example .env
nano .env   # fill in GEMINI_API_KEY and ADMIN_PASSWORD
npm install

# 4. Run with PM2 so it survives reboots
sudo npm install -g pm2
pm2 start server/index.js --name studio
pm2 save
pm2 startup    # follow the printed instructions
```

The app now runs on port 3000. To expose it on port 80/443 with HTTPS, put Caddy or Nginx in front.

**Caddy — easiest, auto HTTPS:**
```
# /etc/caddy/Caddyfile
your-domain.com {
    reverse_proxy localhost:3000
}
```
```bash
sudo systemctl reload caddy
```

**Nginx:**
```
# /etc/nginx/sites-available/studio
server {
    listen 80;
    server_name your-domain.com;
    client_max_body_size 15M;   # for case file uploads

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```
Then add HTTPS: `sudo certbot --nginx -d your-domain.com`

### Option B — Docker

```bash
docker build -t studio .
docker run -d --name studio \
  -p 3000:3000 \
  -e GEMINI_API_KEY=your_key \
  -e ADMIN_PASSWORD=your_password \
  -v studio-data:/app/server \
  studio
```

The volume keeps the SQLite database and uploaded files across container restarts.

### Option C — Managed platform (Railway, Render, Fly.io)

Zero-DevOps options. The flow is similar across all three:

1. Push the project to a GitHub repo
2. Create a new Web Service on the platform, point it at your repo
3. Set environment variables: `GEMINI_API_KEY`, `ADMIN_PASSWORD`
4. Attach a **persistent disk** mounted at `/app/server` (without this, your database resets on every deploy)

Build command: `npm install` · Start command: `npm start`

Railway is the smoothest of the three for this stack.

---

## Maintenance

**Updating the code:**
```bash
pm2 stop studio
# replace files (don't overwrite server/data.db or server/uploads/)
npm install
pm2 restart studio
```

**Backing up:**
Only two things matter — the database and the uploaded files:
```bash
tar -czf backup-$(date +%F).tar.gz server/data.db server/uploads/
```

**Customizing the AI's teaching style:**
Edit the `systemPrompt` string in `server/index.js` (around line 220), then `pm2 restart studio`.

**Wiping data:**
```bash
pm2 stop studio
rm server/data.db server/uploads/*
pm2 start studio
```

---

## Security notes

- **Change `ADMIN_PASSWORD`** from the default `changeme` before going public
- The Gemini API key stays in `.env` on the server — students never see it
- Anyone with the URL can register as a student. If you need stricter access, put HTTP basic auth in front via Nginx/Caddy, or share the link privately with your class
- For any public deployment, use HTTPS (free via Caddy or Let's Encrypt)
- File upload limit is 10 MB; adjust in `server/index.js` if needed

## Tech stack

- Node.js 20+ · Express · SQLite (via better-sqlite3) · Multer for uploads
- Vanilla HTML/CSS/JS frontend (no build step)
- Google Gemini API for AI responses
- About 420 lines of server code, two single-file HTML pages
