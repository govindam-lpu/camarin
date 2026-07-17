# Darkroom — AI-Powered Media Processing Microservice

[![CI](https://github.com/govindam-lpu/camarin/actions/workflows/ci.yml/badge.svg)](https://github.com/govindam-lpu/camarin/actions/workflows/ci.yml)

Upload images → they're stored durably, queued, and processed **asynchronously** by a worker running a three-step AI pipeline (**caption → labels → safety check**) → enriched results stream into a live-updating UI. Users never wait on AI: uploads return a job ID immediately.

- **Live demo:** **https://34-131-77-35.nip.io** — sign up, upload an image, watch the real AI pipeline run
- **Deploy guide:** [deploy/README.md](deploy/README.md) — one small VM runs the exact compose stack + Caddy for automatic HTTPS
- **API collection:** [openapi.yaml](server/openapi.yaml) (live Swagger UI at `/api/docs`) · [Postman collection](postman_collection.json)
- **Assumptions & decisions:** [documented below](#assumptions--decisions-where-the-spec-was-open-ended) — the open-ended choices and the reasoning behind each ⭐

---

## Quickstart (zero configuration)

```bash
docker compose up --build
# → http://localhost:8080
```

That's the entire setup. The stack starts in **mock AI mode** — deterministic fake providers, no API keys needed — so the full system (API, worker, Redis queue, Mongo) is demoable immediately. Sign up, drop an image, watch the pipeline develop it.

**Switch to real AI** (Hugging Face captioning + Google Vision labels/SafeSearch): create a `.env` next to `docker-compose.yml`:

```env
AI_PROVIDER=real
HF_TOKEN=hf_...        # huggingface.co → Settings → Access Tokens → new "Read" token
GCV_API_KEY=AIza...    # see "Obtaining API keys" below
```

**Demo the failure & moderation flows** (mock mode) — filenames drive scenarios:

| Upload a file named… | What happens | What it demonstrates |
|---|---|---|
| `flagme.png` | SafeSearch returns LIKELY/adult | Flagged badge + safelight bar in list, flagged banner in detail, in-app notification |
| `flaky.png` | Fails attempt 1, succeeds attempt 2 | Automatic retry with exponential backoff |
| `failme.png` | Fails all 3 attempts | Failed state + error surface + manual **Retry** button |
| `badreq.png` | Permanent error | Fail-fast: no retries burned on non-retryable errors |
| anything else | Clean run | caption, labels, safety matrix |

Parallelism: select **multiple files at once** — they process concurrently (`WORKER_CONCURRENCY=4` per worker; `docker compose up --scale worker=3` for more processes).

---

## Requirements coverage

Every requirement in the brief, and where it lives:

| Requirement | Where / how |
|---|---|
| Sign up & log in; **all** endpoints authenticated; auth choice documented | JWT Bearer + bcrypt(12); `requireAuth` on every route (unauth → 401); rationale in [Assumptions & decisions](#assumptions--decisions-where-the-spec-was-open-ended) |
| Uploads restricted to JPG/PNG/WEBP, clear error otherwise | MIME whitelist **and** magic-byte content sniff → 400 (a renamed `.txt` is caught) |
| Max 5 MB, enforced **at the API layer** | multer limit → 413 `FILE_TOO_LARGE` (not just a frontend check) |
| Assign job ID, store file, create `pending` job, enqueue, return immediately | `POST /api/jobs` → **201 + job ID instantly**; processing never blocks the response |
| UI: signup/login · upload · job list with statuses · detail with full results · **retry failed** | React SPA — all five, verified end-to-end |
| Status updates via polling or WebSockets (documented) | Polling that **stops when idle**, choice documented below |
| Flag when SafeSearch returns LIKELY/VERY_LIKELY; store the category | `computeFlaggedCategories` — POSSIBLE deliberately does **not** flag |
| Flagged jobs surfaced distinctly + user notified | Distinct row styling + "Flagged" filter + in-app notification center |
| MERN · queue · Docker (mandatory) · Kubernetes (bonus) | Mongo/Express/React/Node · BullMQ+Redis · Dockerfile + compose · [k8s/](k8s/) manifests |
| `docker compose up` brings up API + worker + queue + database | Verified — 4 services, zero config → working system |
| Deliverables: repo · deployed URL · API collection · README | This repo · [live](https://34-131-77-35.nip.io) + [deploy guide](deploy/README.md) · OpenAPI `/api/docs` + [Postman](postman_collection.json) · this file |
| Tests on worker pipeline logic + retry behavior (minimum) | 53 tests; [pipeline.test.ts](server/tests/pipeline.test.ts) + [retry.test.ts](server/tests/retry.test.ts) |
| Bonus: scalability under 10× articulated | [Scalability](#scalability-how-this-behaves-at-10-and-what-breaks-first) section |

---

## Architecture

```mermaid
flowchart LR
    B[Browser<br/>React SPA] -->|JWT Bearer<br/>same origin| A[API<br/>Express / TS]
    A -->|1. validate: size, MIME,<br/>magic bytes| A
    A -->|2. put file| S[(Storage<br/>local disk / S3-compatible)]
    A -->|3. create job: pending| M[(MongoDB<br/>users, jobs, notifications)]
    A -->|4. enqueue jobId| R[(Redis<br/>BullMQ queue)]
    W[Worker<br/>same image,<br/>2nd entrypoint] -->|consume, concurrency N| R
    W -->|get file| S
    W -->|caption| HF[Hugging Face Inference<br/>hosted VLM]
    W -->|labels + SafeSearch| GV[Google Cloud Vision]
    W -->|checkpoint each step,<br/>flagged calc, notify| M
    B -.->|poll 1.5–2.5s<br/>while active| A
```

**Job lifecycle** (each step checkpointed to Mongo the moment it completes):

```mermaid
stateDiagram-v2
    [*] --> pending: upload → 201 + jobId (instant)
    pending --> processing: worker picks up
    processing --> completed: all 3 steps done → flagged calc → notify if flagged
    processing --> pending: transient error, attempts left (backoff 3s→6s→12s)
    processing --> failed: permanent error (fail fast) OR attempts exhausted → notify
    failed --> pending: user presses Retry (fresh budget, completed steps skipped)
    completed --> [*]
```

---

## Assumptions & decisions (where the spec was open-ended)

**Assumptions I made:**

- **Ownership** — every job belongs to exactly one user; users only ever see and act on their own jobs (enforced on every route). No org/sharing model.
- **Job identity** — the Mongo `ObjectId` is the public job ID, used end-to-end (DB, queue, API, UI) — no separate UUID layer.
- **"Flagged" is read literally** — a job is flagged only when SafeSearch returns `LIKELY` or `VERY_LIKELY` for a category; `POSSIBLE` does **not** flag (every likelihood is still stored and shown).
- **AI accuracy is not the goal** — per the brief, the pipeline *engineering* is what's assessed. A deterministic `mock` provider backs local review and the tests; `real` wires the actual APIs.
- **Whole-file processing** — the 5 MB cap keeps in-memory buffers small and bounded, so there's no streaming machinery.
- **Single-VM prod uses local-disk storage** — the API and worker share one volume, so no object store is needed at this scale; `s3` is the drop-in for multi-node.

**Decisions where the spec said "your choice" / left it open:**

| Open-ended point | Choice | Why (short) |
|---|---|---|
| **Queue** | BullMQ on Redis | Retries, exponential backoff, concurrency, and stalled-job recovery are built in — zero custom retry plumbing. RabbitMQ/Kafka would be more ops for no gain here. |
| **Auth** | Stateless JWT (Bearer) + bcrypt(12) | Horizontally scalable, no session store, trivial from the SPA / Postman / curl. Documented trade-off: no server-side revocation (bounded by a 24 h expiry). |
| **File storage** | Adapter: `local` disk / any S3-compatible | Reviewers need zero cloud creds locally; prod containers share no disk. One interface — `local` for compose, `s3` (GCS/R2/B2/MinIO) for scale-out. |
| **Status updates** | Polling that **stops when idle** | Jobs take 5–15 s; sub-second latency isn't worth a third stateful system. Polling is stateless and proxy-friendly; SSE/WebSockets is the documented upgrade path. |
| **Flagged notification** | In-app notification center | Self-contained and demoable in compose with no third-party creds; email is a future channel behind the same write. |
| **AI models** | `mock` + `real`; caption via a hosted vision model on the HF router | The brief says the model isn't the point. HF retired the task-specific BLIP endpoint, so captioning goes through the router's chat API with `google/gemma-3-4b-it` — a ~30-line swap behind the provider seam, which is exactly why that seam exists. |
| **CI/CD** | GitHub Actions — lint + typecheck + tests + Docker build on every push | Zero-secret CI; the same image it builds is what deploys. |
| **Cloud platform** | Single VM running the exact `docker compose` stack + Caddy for TLS | "What you review locally is what runs in prod" — the deployment adds only HTTPS termination. |
| **API ↔ worker split** | One package, two entrypoints, one image | They share models/providers/config; separate packages would add tooling for no gain at this size. |
| **Pipeline shape** | Three sequential steps, each checkpointed to Mongo | Matches the brief's framing; checkpoints let a retry resume from the failed step instead of re-paying for completed AI calls. |

### Decision-code legend

The `(D-xxx)` markers throughout the source and infra files resolve here — one line each. The full log (alternatives weighed, trade-offs, and when I'd revisit each) is in `DECISIONS.md`, submitted alongside.

| Code | Decision |
|---|---|
| D-001 | **Queue: BullMQ on Redis** — retries, exponential backoff, concurrency, and stalled-job recovery are built in |
| D-002 | **Auth: stateless JWT (Bearer) + bcryptjs(12)** — horizontally scalable, no session store; user re-loaded per request |
| D-003 | **Storage adapter** — `local` disk (compose) and `s3` (GCS/R2/B2/MinIO) behind one interface |
| D-004 | **AI providers behind an interface + first-class `mock` mode** — `docker compose up` works with zero API keys |
| D-005 | **Mock demo hooks via magic filenames** — `flagme`/`flaky`/`failme`/`badreq` exercise every path in seconds |
| D-006 | **Status updates: polling that stops when idle** — stateless and proxy-friendly; SSE/WebSockets is the upgrade path |
| D-007 | **Flagged notification: in-app center**, not email — self-contained, demoable with no third-party creds |
| D-008 | **Pipeline: three sequential steps, each checkpointed to Mongo** — a retry resumes from the failed step |
| D-009 | **Failure model: typed `retryable` errors + bounded retries** — permanent errors fail fast; finality is deterministic and unit-tested |
| D-010 | **Repo shape: one server package, two entrypoints** (api/worker), one image |
| D-011 | **TypeScript run via `tsx`** — `tsc --noEmit` typecheck gate, Vitest, ESLint + Prettier |
| D-012 | **Flagged rule: only LIKELY / VERY_LIKELY flag** — `POSSIBLE` does not |
| D-013 | **Image serving: authenticated API byte stream** → blob URL in the SPA (an `<img src>` can't carry auth) |
| D-014 | **Files as Buffers, not streams** — bounded by the 5 MB cap |
| D-015 | **Upload validation: size + MIME whitelist + magic-byte sniff** at the API layer (a renamed file is caught) |
| D-016 | **bcryptjs over native bcrypt** — no node-gyp build in Alpine images |
| D-017 | **HTTP client: native `fetch`**, no axios |
| D-018 | **Enqueue failure at upload → job `failed (QUEUE_ENQUEUE_FAILED)`**, not HTTP 500 — file is durable, Retry recovers |
| D-019 | **Job identity: the Mongo ObjectId is the public job ID** — one ID end-to-end |
| D-020 | **Bounded queue operations** — timeouts so a Redis outage fails fast instead of hanging requests |
| D-021 | **Zero-infra dev harness** — in-memory Mongo + inline queue driver (`scripts/dev-standalone.ts`) |
| D-022 | **SafeSearch renders only for a completed safety step** — step status is the source of truth, not data truthiness |
| D-023 | **Caption model: hosted VLM via the HF router**, not BLIP — HF retired task-specific image-to-text serving |

---

## Failure handling (the part worth reading)

Every provider error is **classified** at the source:

| Failure | Class | Behavior |
|---|---|---|
| HF 503 "model loading" (cold start) | retryable | BullMQ retries the job with exponential backoff; completed steps skip via checkpoints |
| HTTP 429 (rate limit), 5xx, network faults | retryable | same |
| HTTP 401/403 (bad key), 404 (model gone), 400 | permanent | `UnrecoverableError` — fails immediately, no retries burned |
| Unknown/unexpected errors | retryable | transient until proven otherwise; a real bug still exhausts 3 attempts and fails cleanly |
| Stored file missing | permanent | a missing file won't reappear |
| Redis down at upload time | degraded | job saved as `failed (QUEUE_ENQUEUE_FAILED, retryable)` — the file is already durable, the UI Retry recovers it; the request never hangs (5s bounded enqueue) |
| Worker SIGKILLed mid-job | recovered | BullMQ stalled-job detection re-queues; a QueueEvents reconciler keeps Mongo truthful so nothing is stuck `processing` forever |
| Worker SIGTERM (deploy) | graceful | in-flight jobs finish before exit |

Finality is computed from our own attempt counter in Mongo (not queue-library internals), so the retry semantics are deterministic and unit-tested — see [tests/retry.test.ts](server/tests/retry.test.ts).

---

## API

Swagger UI is served by the API at **`/api/docs`**; the raw spec is [server/openapi.yaml](server/openapi.yaml) (imports directly into Postman: *Import → select the yaml*).

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/signup` · `/api/auth/login` | Get a JWT (`Authorization: Bearer <token>` everywhere else) |
| GET | `/api/auth/me` | Session restore |
| POST | `/api/jobs` | Multipart upload → **201 + job immediately** (5MB cap, JPG/PNG/WEBP, magic-byte verified) |
| GET | `/api/jobs?status=&flagged=&page=` | Paginated own-jobs list + `activeCount` (drives polling) |
| GET | `/api/jobs/:id` | Full results: caption, labels, safety matrix, per-step telemetry |
| POST | `/api/jobs/:id/retry` | Re-queue a failed job (completed steps keep their results) |
| GET | `/api/jobs/:id/image` | The stored image (owner-only, streamed after auth) |
| GET | `/api/notifications` · POST `/api/notifications/read` | In-app notification center |
| GET | `/api/health` | Mongo/Redis/AI-mode readiness |

All errors share one shape: `{ "error": { "code": "FILE_TOO_LARGE", "message": "…" } }`.

---

## Environment variables

Everything is validated at boot (zod) — invalid/missing config **fails fast with a named error**, including refusing the default JWT secret in production. Full annotated list: [.env.example](.env.example).

| Variable | Default | Notes |
|---|---|---|
| `MONGO_URI` / `REDIS_URL` | localhost | compose wires these to its own services |
| `JWT_SECRET` | dev default | production boot refuses the default value |
| `MAX_FILE_SIZE_MB` | `5` | enforced at the API layer (413) |
| `STORAGE_DRIVER` | `local` | `local` (shared volume) or `s3` (GCS/R2/B2/MinIO via one code path) |
| `S3_ENDPOINT/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY` | — | required iff `STORAGE_DRIVER=s3` |
| `AI_PROVIDER` | `mock` | `real` requires the two keys below |
| `HF_TOKEN` | — | Hugging Face read token |
| `HF_CAPTION_URL` / `HF_CAPTION_MODEL` | HF router chat API / `google/gemma-3-4b-it` | swap caption models without code changes (HF retired the task-specific BLIP endpoint — see Assumptions & decisions) |
| `GCV_API_KEY` | — | Google Cloud Vision API key |
| `WORKER_CONCURRENCY` | `4` | parallel jobs per worker process |
| `JOB_ATTEMPTS` / `JOB_BACKOFF_MS` | `3` / `3000` | retry budget & exponential backoff base |

### Obtaining API keys (~5 minutes total)

**Hugging Face** (captioning): [huggingface.co](https://huggingface.co) → sign up (free) → *Settings → Access Tokens → Create new token* (type: **Read**) → that's `HF_TOKEN`.

**Google Cloud Vision** (labels + SafeSearch): [console.cloud.google.com](https://console.cloud.google.com) → create/select a project → billing must be enabled (free tier: 1,000 units/month/feature) → *APIs & Services → Library →* enable **Cloud Vision API** → *Credentials → Create credentials → API key* → that's `GCV_API_KEY`. (Recommended: restrict the key to the Vision API.)

---

## Development

```bash
# Full stack:
docker compose up --build

# Or bare-metal against real deps you run yourself:
cd server && npm i && npm run dev:api     # + npm run dev:worker in another shell
cd web && npm i && npm run dev            # Vite on :5173, proxies /api → :8080

# Zero-infra full-product mode (in-memory Mongo + in-process queue driver + mock AI —
# the entire pipeline runs with no Docker/Redis; pair with the Vite dev server):
cd server && npx tsx scripts/dev-standalone.ts
```

### Tests

```bash
cd server && npm test        # 53 tests
```

Coverage targets what the spec calls out — **worker pipeline logic and retry behavior** — plus the validation gates:

- `pipeline.test.ts` — step orchestration, per-step checkpoint resume, flagged mapping (incl. *POSSIBLE does not flag*), idempotent redelivery, notification creation, `markJobFailed` idempotency
- `retry.test.ts` — transient→recovers, permanent→fails fast, exhaustion→failed, unknown-error default, all four mock demo hooks
- `api.test.ts` — upload validation trio (size/MIME/magic bytes), ownership scoping, enqueue-failure degradation, manual-retry reset semantics, notifications, auth
- `imageSniff.test.ts` — magic-byte edge cases

Real Mongo semantics via `mongodb-memory-server`; queue and AI providers are injected fakes — **no network, no Redis** needed in tests. CI (GitHub Actions) runs lint + typecheck + tests + a full Docker build on every push.

---

## Project structure

```
├─ docker-compose.yml     # api + worker + redis + mongo, zero-config
├─ server/                # one package, two entrypoints (api + worker)
│  ├─ openapi.yaml        # served at /api/docs
│  ├─ Dockerfile          # multi-stage; SPA baked into the API image
│  └─ src/
│     ├─ api/             # express: routes, middleware, serializers
│     ├─ worker/          # pipeline (checkpointed steps) + retry processor
│     ├─ providers/       # ai/{mock,huggingface,googleVision} · storage/{local,s3}
│     ├─ models/          # User, Job (explicit contract), Notification
│     ├─ queue/           # BullMQ + bounded enqueue/ping
│     └─ config/          # zod-validated env, fail-fast
└─ web/                   # React 19 + Vite + Tailwind v4 + TanStack Query
```

---

## Scalability: how this behaves at 10× (and what breaks first)

*(Analysis, not implementation — per the brief.)*

1. **First bottleneck: external AI quotas/rate limits**, not our infra. GCV free tier is 1,000 units/month/feature; HF free inference is aggressively rate-limited. Adding workers past that point just converts queue depth into 429s. Levers, in order: BullMQ's per-queue rate limiter matched to provider quotas; batch GCV features (labels+SafeSearch in one request — halves round-trips); **content-hash dedupe** (identical bytes → reuse results; big win for platforms with meme-like reuploads); paid tiers.
2. **Workers scale linearly until then** — stateless consumers: `--scale worker=N` in compose, replicas in k8s (queue-depth HPA via KEDA is the natural trigger; manifests in [k8s/](k8s/)).
3. **API scales horizontally already** — stateless JWT, no sessions, no sticky requirements. N replicas behind any LB.
4. **Polling load** grows with concurrent active users (~0.4 req/s each while jobs run, zero when idle). At 10× it's fine (the list query is one indexed read); at 100× swap to SSE/socket.io fanned out via Redis pub/sub — the worker already centralizes every state transition, so the emit point exists.
5. **Image serving through the API** becomes the bandwidth hog: switch the storage adapter to presigned GET URLs + CDN (the seam already exists).
6. **Redis** is the single queue broker: managed Redis with persistence/replica (queue survives broker restarts thanks to AOF locally, RDB+replica in prod).
7. **Mongo**: job docs are small and write patterns are per-step updates on one doc — indexes already cover the hot paths `(userId, createdAt)`, `(status)`, `(flagged)`. Shard-by-userId is the eventual story, far past 10×.

---

## Known limitations & what I'd do with more time

Deliberate cuts, and why:

- **No email notifications** — in-app only; the notification write is behind one seam, Resend would slot in.
- **No WebSockets/SSE** — polling is the right cost/benefit at 5–15s job durations.
- **No refresh-token rotation / revocation** — 24h expiry bounds it; production auth would add httpOnly refresh cookies.
- **No presigned URLs/CDN, no content-hash dedupe** — the two highest-value scale levers not needed at review scale.
- **No admin/moderation view** for flagged content; out of spec scope.
- **E2E browser tests** skipped in favor of deep unit coverage of pipeline/retry (the spec's stated bar).
- HF serverless model availability shifts over time — `HF_CAPTION_URL` is env-swappable and the provider seam makes a full swap ~20 lines (this is why it exists).
