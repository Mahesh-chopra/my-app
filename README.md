# Cloud Android Emulator Runner (MVP)

Run an Android app from a browser. The frontend uploads an APK, the Node.js orchestrator creates a timed session, and a redroid container + ws-scrcpy stream provide the live device view. Docker execution is optional and off by default so the UI can be tested on any machine.

## Local quick start (Docker disabled)

Requirements: Node.js 18+ (Node 20/22 LTS recommended). Docker and Linux are **not** needed for this mode. Redroid does not use KVM either — see below.

```bash
cd cloud-android-emulator
npm install
cp .env.example .env      # already present locally; edit if needed
npm start
```

Open <http://localhost:3000>.

`ENABLE_DOCKER=false` (the default) means:

- APKs are still validated, stored in `uploads/`, and deleted on stop/expiry.
- Session IDs, countdown, controls, and API calls all work.
- The phone screen shows a placeholder and `streamUrl` is `null`.
- `POST /api/session/start` returns the prepared Docker/ADB command templates in `preparedCommands` so you can inspect them.

### API smoke test

```bash
curl http://localhost:3000/api/health

curl -F "apk=@/path/to/app.apk" http://localhost:3000/api/session/start
# copy sessionId from the response
curl -X POST -H "Content-Type: application/json" \
  -d '{"action":"home"}' \
  http://localhost:3000/api/session/SESSION_ID/action

curl -X POST http://localhost:3000/api/session/SESSION_ID/stop
```

Supported actions: `home`, `back`, `recent`, `volumeUp`, `volumeDown`, `power` (mapped to Android keyevents 3, 4, 187, 24, 25, 26).

## Running redroid + ws-scrcpy on a Linux host

Redroid is a containerized Android, **not a VM**: KVM is not required. It needs a Linux host with the `binder` and `ashmem` kernel modules exposed to the container (started with `--privileged`). This works on x86_64 and ARM64, so free ARM instances such as Oracle's Ampere A1 are viable.

1. **Install Docker Engine and load the required kernel modules:**

   ```bash
   sudo apt-get update
   sudo apt-get install -y docker.io
   sudo modprobe ashmem_linux
   sudo modprobe binder_linux devices="binder,hwbinder,vndbinder"
   lsmod | grep -E 'binder|ashmem'
   ```

   Some kernels name the modules `binder` / `ashmem` instead, or need `linux-modules-extra-$(uname -r)` (and sometimes a reboot) before `modprobe` succeeds. If your host's kernel has no binder/ashmem support, redroid will not start there — verify on the VM before committing to it.

2. **Pull images.** For ARM64 hosts, pick an ARM64 redroid tag, for example:

   ```bash
   docker pull redroid/redroid:15.0.0_64only-latest   # ARM64
   # or: docker pull redroid/redroid:14.0.0-latest    # multi-arch
   docker pull remoteview/ws-scrcpy:latest            # confirm arm64 support for your image
   ```

3. **Configure `.env` on the host:**

   ```dotenv
   ENABLE_DOCKER=true
   PUBLIC_HOST=your.vps.ip.or.domain
   ADB_HOST=127.0.0.1
   ADB_PORT_BASE=5555
   STREAM_PORT_BASE=8000
   REDROID_IMAGE=redroid/redroid:15.0.0_64only-latest
   WS_SCRCPY_IMAGE=remoteview/ws-scrcpy:latest
   ```

   `DOCKER_HOST` is optional: leave it empty to use the local Docker CLI, or set it to your Docker daemon endpoint. Never put Docker credentials in source files — use `.env` or your platform's secret store.

4. **Start the app:** `npm start`. On upload, `server/dockerManager.js` builds two `docker run` commands (redroid with `--privileged`, plus ws-scrcpy), runs them, installs the APK with `adb install -r`, and returns a `streamUrl` for the iframe. Stopping or expiring a session removes both containers and the APK.

> The ws-scrcpy env flags in `buildDockerPlan()` are a **template**. Different ws-scrcpy images use different variable names; confirm the flags for the image you choose and adjust that one function. The MVP does not add authentication, TLS, per-user quotas, or persistent state.

## Zero-cost deployment path (₹0)

| Layer | Free option | Notes |
| --- | --- | --- |
| Frontend | Cloudflare Pages / Workers | Static HTML/CSS/JS at no cost; no card required. |
| Dev backend | GitHub Codespaces | 60 free hours/month on a 2-core, 8 GB Linux VM with Docker. Good for build + smoke tests; sleeps when idle. Confirm binder/ashmem support on the Codespaces kernel before relying on redroid there. |
| Always-on backend | Oracle Cloud Always Free (Ampere ARM) | 2 ARM cores + 12 GB RAM + 200 GB storage + 10 TB egress/month, indefinitely free. Needs a card for a small temporary verification hold. Use an ARM64 redroid tag. |
| APK storage / DB | Supabase or Firebase free tier | 500 MB DB + 1 GB file storage is plenty for temporary APKs/accounts. Supabase free projects pause after 7 days of inactivity. |
| Skip hosting Android | Appetize.io free plan | Embed an Android emulator via `<iframe>` with limited free minutes; no card to start. |

Recommended order:

1. Push this project to a free GitHub repo and open it in **Codespaces** (`.devcontainer/devcontainer.json` installs Node + Docker-in-Docker and forwards ports 3000/5555/8000). Run `npm start` and use the forwarded port.
2. Deploy `public/` to **Cloudflare Workers static assets** with `npm run deploy:pages` (uses `wrangler.toml`; first run prompts for Cloudflare login).
3. On an **Oracle Always Free Ampere A1 Ubuntu VM**, follow the Oracle section below. `deploy/oracle/setup.sh` installs Docker + binder/ashmem, enables `ENABLE_DOCKER=true`, starts a systemd service, and configures Nginx.

### Split frontend ↔ backend wiring

The frontend supports a configurable API origin. In `public/index.html`:

```html
<body data-api-base="https://your-backend.example.com">
```

Leave it empty when the API is served from the same origin. The backend emits CORS headers only when `CORS_ORIGIN` is set in `.env`; set it to your exact Workers/Pages origin (or `*` for a public demo). `npm run deploy:pages` uses a locally pinned Wrangler dev dependency, so deploys don't depend on fetching the latest CLI.

The host setup script, redroid image, and ws-scrcpy env-var names are configurable via `.env` (`REDROID_IMAGE`, `WS_SCRCPY_ADB_HOST_ENV`, `WS_SCRCPY_ADB_PORT_ENV`). On ARM64 hosts the default redroid image becomes `redroid/redroid:15.0.0_64only-latest`. Startup runs a non-fatal binder/ashmem preflight when `ENABLE_DOCKER=true`.

### Windows keepalive (local tunnel)

Cloudflare quick tunnels get a new random URL each time they restart. `deploy/windows/keepalive.ps1` keeps the local API and tunnel running, detects a new URL, redeploys the frontend with it, then restores `public/index.html` to `data-api-base=""`. On this machine it is registered as a Task Scheduler task that runs every 2 minutes:

```powershell
schtasks /create /tn CloudAndroidEmulatorKeepalive /tr 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Users\chopr\cloud-android-emulator\deploy\windows\keepalive.ps1"' /sc minute /mo 2 /f
```

Logs are written to `%TEMP%\caer-keepalive.log`. Registration is machine-local and is not part of the repo.

### Oracle Always Free (permanent backend)

1. **Sign up** at https://cloud.oracle.com — a card is required for a small temporary verification hold. Pick a home region near you.
2. **Create the VM:** Compute → Instances → Create Instance:
   - Image: **Ubuntu 22.04/24.04 ARM64 (aarch64)**
   - Shape: **VM.Standard.A1.Flex**, 2 OCPU / 12 GB RAM (Always Free)
   - Add your SSH key and assign a public IP.
3. **Open ports** 80 and 443 in the VCN security list (port 3000 only temporarily, for direct testing).
4. SSH in and run:

   ```bash
   curl -O https://raw.githubusercontent.com/Mahesh-chopra/my-app/master/deploy/oracle/setup.sh
   PUBLIC_HOST=your.public.ip CORS_ORIGIN=https://cloud-android-emulator.legderdeskonline.workers.dev bash setup.sh
   ```

   The script clones the repo into `~/my-app`, creates `.env` from `.env.example`, pulls the ARM64 redroid image, starts `cloud-android.service`, and configures Nginx (`client_max_body_size 120M`).
5. **Verify:** `curl http://your.public.ip/api/health` and `sudo systemctl status cloud-android`.
6. **Point the frontend at it:** set `<body data-api-base="http://your.public.ip">` in `public/index.html`, then run `npm run deploy:pages`. For HTTPS, terminate TLS at Nginx with certbot and use the `https://` URL instead.

> The ws-scrcpy env flags remain a template; confirm them for your chosen image in `server/dockerManager.js`.

### Production notes

- Put the app behind a TLS reverse proxy (Nginx/Caddy). Do not publish the Docker socket or raw ADB ports to the internet.
- Add authentication and signed, short-lived session tokens before exposing this publicly.
- Restrict upload size at the proxy too, and run the Node process as an unprivileged user.
- Replace the in-memory `sessionStore.js` with shared storage if you run more than one app instance.

## Project structure

```
cloud-android-emulator/
├── AGENTS.md                # contributor/agent rulebook
├── README.md
├── package.json
├── wrangler.toml            # Cloudflare Workers static-assets config
├── .env.example             # committed template
├── .env                     # local config (gitignored)
├── .gitignore
├── .devcontainer/
│   └── devcontainer.json    # GitHub Codespaces setup
├── deploy/
│   ├── oracle/
│   │   ├── setup.sh         # Oracle ARM VM: Docker, service, Nginx
│   │   └── nginx.conf       # reverse proxy template
│   └── windows/
│       └── keepalive.ps1    # local tunnel self-healing + frontend re-point
├── scripts/
│   └── setup-linux.sh       # generic Docker + binder/ashmem host prep
├── public/
│   ├── index.html           # dashboard markup + data-api-base
│   ├── style.css            # responsive layout + 9:16 viewport
│   └── app.js               # upload, stream, controls, countdown
├── server/
│   ├── server.js            # Express routes + lifecycle + CORS
│   ├── sessionStore.js      # in-memory sessions
│   ├── dockerManager.js     # Docker templates, execution, preflight
│   └── adb.js               # keyevent map + ADB commands
└── uploads/                 # runtime APK storage (gitignored)
```

## Verification

```bash
npm run check     # node --check on every JS file
npm start         # must print the listening message with no errors
```
