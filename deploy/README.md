# Deploying to a single VM

The deployed system **is** the local `docker compose` stack — same image, same services, same
config — running on one small VM, fronted by [Caddy](https://caddyserver.com) for automatic
HTTPS. Nothing about the app changes between "runs on my laptop" and "runs in production" (D-014).

This guide uses **Google Cloud Compute Engine** (an `e2-small`), because the project already
uses GCP for the Vision API — no new account or card. Any Ubuntu VM from any provider works
identically; only the console click-path differs.

## Why a VM (and not a PaaS)

- The full system is four cooperating services (API, worker, Redis, Mongo). On a single VM the
  local-disk storage driver just works, because the API and worker share one filesystem — no
  object store required at this scale.
- "What you review locally is what runs in production" is a stronger correctness story than a
  bespoke PaaS wiring. The only production-only addition is TLS termination (Caddy).
- Free-tier PaaS options either don't run a persistent background worker for free, or require a
  card. This path reuses the GCP account already in play.

## Steps

### 1. Create the VM (GCP console)

1. **Compute Engine → VM instances → Create instance** (enable the API if prompted).
2. Name `camarin`; Region a nearby one (e.g. `asia-south1`); Machine type **e2-small** (2 GB RAM).
3. Boot disk: **Ubuntu 24.04 LTS**, 20 GB.
4. Under **Firewall**, tick **Allow HTTP traffic** and **Allow HTTPS traffic**.
5. **Create.**

### 2. Deploy (VM SSH — click the "SSH" button on the instance)

```bash
git clone https://github.com/govindam-lpu/camarin.git && cd camarin
sudo bash deploy/setup.sh     # writes .env template, then stops
nano .env                     # set HF_TOKEN and GCV_API_KEY (JWT secret is pre-generated)
sudo bash deploy/setup.sh     # builds + launches; prints your https URL
```

The script installs Docker, derives an HTTPS hostname from the VM's public IP via
[nip.io](https://nip.io) (so Caddy can obtain a real Let's Encrypt certificate — no domain
purchase), and brings up the whole stack. First load waits ~30 s for the cert.

### 3. Verify

- `https://<dashed-ip>.nip.io/api/health` → `{"ok":true,...,"aiProvider":"real"}`
- `https://<dashed-ip>.nip.io/api/docs` → Swagger UI
- Open the root URL → sign up → upload a photo → watch the real caption/labels/safety land.

## Operating it

```bash
docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml logs -f     # tail logs
docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml ps          # status
docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml up -d --scale worker=3   # more workers
docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml down        # stop everything
```

## Notes & fallbacks

- **Plain HTTP instead of TLS:** set `SITE_ADDRESS=:80` in `.env` and re-run — serves on
  `http://<ip>` with no certificate step.
- **Truly $0 (e2-micro):** the always-free `e2-micro` (1 GB) works if Mongo is offloaded to a
  free Atlas M0 cluster (set `MONGO_URI` in `.env`, remove the `mongo` service) and 2 GB of swap
  is added for the build. Documented here as the zero-cost variant; the e2-small path above is
  simpler.
- **Secrets** live only in the VM's `.env` (never committed). Rotate by editing `.env` and
  re-running the compose up command.
