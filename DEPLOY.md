# Deploying the Tulmi backend to a Hostinger VPS (shared with other apps)

> **Already cloned before the rename?** The backend folder moved from `backend/`
> to `tulmi/`. Update with:
> ```bash
> cd ~/tulmi && git pull
> cp .env.example tulmi/.env && nano tulmi/.env   # re-add your keys
> docker compose up -d --build
> ```

This VPS already runs other apps, so these steps are designed to **not disturb
them**: Flow runs in its own Docker container, binds to **localhost only** on an
**uncommon port (8770)** by default, and never touches ports 80/443 unless you
explicitly choose to.

You only need your two API keys: OpenAI (Whisper STT + voice) and OpenRouter
(text cleanup/refine). Supabase is optional for
the first run (`DEV_SKIP_AUTH=true`).

> Replace `YOUR_VPS_IP` with your VPS IP, and `flow.yourdomain.com` with your
> domain (only needed for HTTPS).

---

## 1. Connect to the VPS

```bash
ssh root@YOUR_VPS_IP
```

## 2. See what's already running (so we don't clash)

Run these and keep the output handy:

```bash
docker --version                 # is Docker already installed?
docker ps                        # your other app containers
ss -tlnp | grep -E ':(80|443|8770)\b'   # what's on 80/443 and is 8770 free?
```

- If **80 or 443** show a process (nginx/apache/caddy/etc.), you already have a
  web server — we'll route Flow through it (Step 6, Option A). **Do not** use
  Flow's bundled Caddy.
- If **8770** shows nothing, it's free for Flow. If it's taken, pick another
  free port and use it as `FLOW_PORT` below.

## 3. Install Docker — ONLY if Step 2 showed it's missing

```bash
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
```

(The `command -v` guard skips the install if Docker is already there, so your
running containers are untouched.)

## 4. Get the code

```bash
# Private repo: make a token at https://github.com/settings/tokens (scope: repo)
git clone https://YOUR_TOKEN@github.com/chedfox/tulmi.git
# Public repo: git clone https://github.com/chedfox/tulmi.git
cd tulmi
```

## 5. Add your keys

```bash
cp .env.example tulmi/.env
nano tulmi/.env       # fill OPENAI_API_KEY + OPENROUTER_API_KEY; keep STT_PROVIDER=openai + DEV_SKIP_AUTH=true
```

Save: `Ctrl+O`, `Enter`, `Ctrl+X`.

## 6. Start Flow

It now listens **only on `127.0.0.1:8770`** — private to the VPS, invisible to
the internet, zero conflict with your other apps:

```bash
docker compose up -d --build
curl http://localhost:8770/healthz
# -> {"status":"ok","service":"tulmi-backend","version":"0.1.0"}
```

(If 8770 was taken, run `FLOW_PORT=NNNN docker compose up -d --build` instead.)

Now make it reachable from your phone. Pick ONE option:

### Option A — Route through your EXISTING web server (recommended)

You already have nginx/apache/caddy on 80/443. Add **one subdomain** that
forwards to Flow; your other sites are untouched. First point DNS:
`flow.yourdomain.com → YOUR_VPS_IP` (an A record).

**If you use nginx** — create `/etc/nginx/sites-available/flow` :

```nginx
server {
    listen 80;
    server_name flow.yourdomain.com;
    location / {
        proxy_pass http://127.0.0.1:8770;
        proxy_http_version 1.1;
        # WebSocket upgrade for the live /v1/stream endpoint:
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 300s;
    }
}
```

Then:

```bash
ln -s /etc/nginx/sites-available/flow /etc/nginx/sites-enabled/flow
nginx -t && systemctl reload nginx          # -t verifies before reloading
# Add HTTPS (free cert) without affecting other sites:
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d flow.yourdomain.com
```

**If you use Caddy** — add to your existing `Caddyfile`:

```caddy
flow.yourdomain.com {
    reverse_proxy 127.0.0.1:8770
}
```

then `caddy reload` (or `systemctl reload caddy`). Caddy gets the HTTPS cert
automatically. WebSockets work with no extra config.

**Apache** — enable `proxy`, `proxy_http`, `proxy_wstunnel`, add a vhost with
`ProxyPass / http://127.0.0.1:8770/` plus a `RewriteRule` upgrading
`Upgrade=websocket` to `ws://127.0.0.1:8770/` — ask me and I'll write it out.

→ Backend is live at `https://flow.yourdomain.com`; the app uses
`wss://flow.yourdomain.com/v1/stream`.

### Option B — Quick public port (testing only, no HTTPS)

Only if **nothing** is on the port and you just want to poke it from your phone:

```bash
FLOW_BIND=0.0.0.0 FLOW_PORT=8770 docker compose up -d --build
ufw allow 8770 2>/dev/null || true     # also open it in Hostinger's hPanel firewall
# reachable at http://YOUR_VPS_IP:8770/healthz
```

Switch to Option A before real use — Android needs HTTPS/`wss://`.

---

## Everyday commands

```bash
docker compose logs -f backend                 # watch logs
docker compose restart backend                 # restart just Flow
docker compose down                            # stop Flow (other apps unaffected)
git pull && docker compose up -d --build       # deploy a new version
```

## Why this won't break your other apps

- Flow's container is isolated; the compose project is namespaced (`tulmi-*`),
  so container/network/volume names can't collide with your other stacks.
- Default binding is `127.0.0.1:8770` — not public, not 80/443.
- The bundled Caddy is opt-in (`--profile https`) and you're advised to use your
  existing proxy instead, so 80/443 are never seized.
- Docker is only installed if missing.

## Notes

- Secrets live only in `tulmi/.env` on the VPS — never committed.
- Swap the cleanup model anytime via `CLEANUP_MODEL` in `tulmi/.env`, then
  `docker compose up -d --build`.
- For real users: set `DEV_SKIP_AUTH=false`, add `SUPABASE_*`, and run the
  migrations in `tulmi/supabase/migrations/`.
