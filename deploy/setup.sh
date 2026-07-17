#!/usr/bin/env bash
#
# One-shot deploy for a fresh Ubuntu VM (GCP e2-small, 2 vCPU / 2GB).
# Runs the entire docker-compose stack (Mongo + Redis + API + worker) plus a
# Caddy reverse proxy for automatic HTTPS.
#
#   Usage on the VM:
#     git clone https://github.com/govindam-lpu/camarin.git && cd camarin
#     sudo bash deploy/setup.sh        # first run: writes .env template, then stop to add keys
#     nano .env                        # paste HF_TOKEN + GCV_API_KEY
#     sudo bash deploy/setup.sh        # second run: builds and launches
#
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root

# ── 1. Docker (idempotent) ───────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  echo ">> installing Docker..."
  curl -fsSL https://get.docker.com | sh
fi

# ── 2. .env — created once, then you fill in the keys ────────────────────────
if [ ! -f .env ]; then
  echo ">> writing .env template..."
  cat > .env <<EOF
# Real AI pipeline. Get keys: HF -> huggingface.co Access Tokens; GCV -> Cloud Vision API key.
AI_PROVIDER=real
HF_TOKEN=REPLACE_WITH_YOUR_HF_TOKEN
GCV_API_KEY=REPLACE_WITH_YOUR_GCV_API_KEY

# Strong random secret generated for you:
JWT_SECRET=$(openssl rand -hex 32)

# Single-VM storage: api & worker share the compose 'uploads' volume.
STORAGE_DRIVER=local
EOF
  echo ""
  echo ">> .env created. Edit it now (set HF_TOKEN and GCV_API_KEY):  nano .env"
  echo ">> then re-run:  sudo bash deploy/setup.sh"
  exit 0
fi

if grep -q "REPLACE_WITH_YOUR" .env; then
  echo "!! .env still has placeholder keys. Edit it (nano .env) and re-run." >&2
  exit 1
fi

# ── 3. HTTPS hostname via nip.io (maps the VM's public IP to a real DNS name) ─
IP="$(curl -fsS ifconfig.me || curl -fsS icanhazip.com)"
SITE="${IP//./-}.nip.io"
# Persist SITE_ADDRESS for compose (idempotent).
grep -q '^SITE_ADDRESS=' .env && sed -i "s|^SITE_ADDRESS=.*|SITE_ADDRESS=${SITE}|" .env || echo "SITE_ADDRESS=${SITE}" >> .env

# ── 4. Launch the full stack + Caddy ─────────────────────────────────────────
echo ">> building & starting the stack..."
docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml up -d --build

echo ""
echo "════════════════════════════════════════════════════════════"
echo "  Deployed.  https://${SITE}"
echo "  (first load waits ~30s while Caddy fetches a TLS cert)"
echo "  Health:    https://${SITE}/api/health"
echo "  API docs:  https://${SITE}/api/docs"
echo "════════════════════════════════════════════════════════════"
