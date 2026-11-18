#!/usr/bin/env bash
# Prepare an Oracle Always Free Ampere A1 (Ubuntu ARM64) VM as the permanent backend.
# Run from the home directory: bash setup.sh
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Mahesh-chopra/my-app.git}"
APP_DIR="${APP_DIR:-$HOME/my-app}"
PUBLIC_HOST="${PUBLIC_HOST:-$(curl -s ifconfig.me)}"
CORS_ORIGIN="${CORS_ORIGIN:-http://$PUBLIC_HOST}"
REDROID_IMAGE="${REDROID_IMAGE:-redroid/redroid:15.0.0_64only-latest}"
WS_SCRCPY_IMAGE="${WS_SCRCPY_IMAGE:-remoteview/ws-scrcpy:latest}"

echo "==> Installing packages"
sudo apt-get update
sudo apt-get install -y docker.io git nginx curl

echo "==> Loading binder/ashmem (redroid does not need KVM)"
sudo apt-get install -y "linux-modules-extra-$(uname -r)" || true
sudo modprobe ashmem_linux 2>/dev/null || true
sudo modprobe binder_linux devices="binder,hwbinder,vndbinder" 2>/dev/null || true
if ! lsmod | grep -Eq 'binder|ashmem'; then
  echo "WARNING: binder/ashmem not detected; redroid may not start on this kernel." >&2
fi

sudo usermod -aG docker "$USER"

echo "==> Fetching application"
if [[ ! -d "$APP_DIR/.git" ]]; then
  git clone "$REPO_URL" "$APP_DIR"
else
  git -C "$APP_DIR" pull --ff-only
fi
cd "$APP_DIR"
npm install

if [[ ! -f .env ]]; then
  cp .env.example .env
fi

set_env() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" .env; then
    sed -i "s|^${key}=.*|${key}=${value}|" .env
  else
    echo "${key}=${value}" >> .env
  fi
}

set_env ENABLE_DOCKER true
set_env PUBLIC_HOST "$PUBLIC_HOST"
set_env CORS_ORIGIN "$CORS_ORIGIN"
set_env REDROID_IMAGE "$REDROID_IMAGE"
set_env WS_SCRCPY_IMAGE "$WS_SCRCPY_IMAGE"

echo "==> Pulling images"
sudo docker pull "$REDROID_IMAGE"
sudo docker pull "$WS_SCRCPY_IMAGE"

echo "==> Installing systemd service"
sudo tee /etc/systemd/system/cloud-android.service > /dev/null <<EOF
[Unit]
Description=Cloud Android Emulator Runner
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=$(command -v node) server/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now cloud-android

echo "==> Installing nginx reverse proxy"
sudo cp deploy/oracle/nginx.conf /etc/nginx/sites-available/cloud-android
sudo sed -i "s|server_name _;|server_name $PUBLIC_HOST;|" /etc/nginx/sites-available/cloud-android
sudo ln -sf /etc/nginx/sites-available/cloud-android /etc/nginx/sites-enabled/cloud-android
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl restart nginx

echo "==> Done. Backend API: http://$PUBLIC_HOST/api/health"
