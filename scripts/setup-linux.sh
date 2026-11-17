#!/usr/bin/env bash
# Prepare an Ubuntu/Debian Linux host (x86_64 or ARM64) for redroid + ws-scrcpy.
# Run from the project root: bash scripts/setup-linux.sh
set -euo pipefail

if [[ ! -f .env ]]; then
  echo "No .env found. Copy .env.example to .env and configure it first." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

echo "==> Installing Docker Engine"
sudo apt-get update
sudo apt-get install -y docker.io

echo "==> Loading binder/ashmem kernel modules"
sudo modprobe ashmem_linux 2>/dev/null || true
sudo modprobe binder_linux devices="binder,hwbinder,vndbinder" 2>/dev/null || true

if lsmod | grep -Eq 'binder|ashmem'; then
  echo "binder/ashmem modules detected."
else
  echo "WARNING: binder/ashmem not detected. Redroid may not start on this kernel." >&2
  echo "Try installing linux-modules-extra-\$(uname -r) and rebooting." >&2
fi

sudo usermod -aG docker "$USER" 2>/dev/null || true

REDROID_IMAGE="${REDROID_IMAGE:-redroid/redroid:14.0.0-latest}"
WS_SCRCPY_IMAGE="${WS_SCRCPY_IMAGE:-remoteview/ws-scrcpy:latest}"

echo "==> Pulling $REDROID_IMAGE and $WS_SCRCPY_IMAGE"
sudo docker pull "$REDROID_IMAGE"
sudo docker pull "$WS_SCRCPY_IMAGE"

echo "==> Done. Log out and back in for the docker group, then run: npm start"
