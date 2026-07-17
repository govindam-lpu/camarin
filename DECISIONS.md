# Decision Log

Every non-obvious engineering decision in this project, with the alternatives considered, why the winner won, and when I'd revisit it. Ordered chronologically. The last section lists things I **deliberately did not build** and why.

Legend: ✅ adopted · 🔁 revisit-when noted

---

## D-001 · Queue: BullMQ on Redis ✅

**Options:** BullMQ+Redis · RabbitMQ · Kafka · Agenda (Mongo-backed) · homegrown Mongo polling
**Decision:** BullMQ on Redis.
**Why:** The job model here (short-lived tasks, per-job retries with exponential backoff, concurrency control, stalled-job recovery when a worker dies mid-run) is exactly BullMQ's feature set — zero custom retry plumbing. Redis is a single lightweight container. RabbitMQ buys stronger routing semantics we don't need at the cost of more ops surface (retry/DLQ wiring is manual). Kafka is a log, not a job queue — wrong tool. Agenda/Mongo-polling would remove the Redis container but has weaker retry semantics, adds polling latency, and the spec's compose file explicitly lists a *queue* as a distinct service.
**Trade-offs:** Redis becomes a stateful dependency; BullMQ is Node-only (fine — worker is Node by spec). 🔁 Revisit if consumers in other languages appear or delivery guarantees need to survive Redis loss (→ RabbitMQ/SQS).

## D-002 · Auth: stateless JWT (Bearer) + bcryptjs ✅

**Options:** JWT Bearer · server-side sessions (cookie + Mongo/Redis store) · OAuth (Google)
**Decision:** JWT access token (24 h expiry, HS256), `Authorization: Bearer`, password hashing with bcryptjs (cost 12).
**Why:** Stateless tokens keep the API horizontally scalable with no shared session store, work identically from the SPA, Postman, and curl (an *API collection* is a deliverable — Bearer is the friendliest for reviewers), and are the fastest correct thing to build in the time budget. OAuth adds a third-party dependency and redirect plumbing that demonstrates nothing extra about pipeline engineering.
**Trade-offs (documented deliberately):** no server-side revocation (mitigated by 24 h expiry); token in `localStorage` is XSS-readable (mitigated by helmet CSP, no third-party scripts, React's escaping). The middleware re-loads the user per request, so deleted users are locked out immediately despite valid tokens.
🔁 Revisit at real-product stage: httpOnly refresh-token rotation + short-lived access tokens.

## D-003 · File storage: adapter with `local` and `s3` drivers ✅

**Options:** local disk only · S3-compatible only · MongoDB GridFS
**Decision:** A ~40-line `StorageAdapter` interface with two drivers: `local` (disk; default in docker-compose, where api & worker share a volume) and `s3` (any S3-compatible endpoint — GCS via HMAC interop keys, R2, B2, MinIO — one code path via `@aws-sdk/client-s3`).
**Why:** The reviewer must be able to `docker compose up` with **zero cloud credentials** → local disk wins locally. In production the API and worker are separate containers with no shared filesystem (Railway volumes don't span services) → object storage is mandatory there. The adapter seam is the parity guarantee, not the backend. GridFS would remove a dependency but abuses the database as a blob store and bloats the free Atlas tier.
**Trade-offs:** two code paths to test; local driver is not durable beyond the volume. 🔁 Revisit: presigned upload/download URLs when file bandwidth through the API becomes the bottleneck (see README scalability notes).

## D-004 · AI providers behind an interface, with a first-class `mock` mode ✅

**Options:** call HF/GCV inline in the worker · thin provider interface (`caption`, `detectLabels`, `checkSafety`) with `real` and `mock` implementations
**Decision:** Provider interface + `AI_PROVIDER=mock|real` env switch. Mock is the compose default.
**Why:** (1) Reviewer UX: `docker compose up` produces a **fully working system with no API keys**. (2) Unit tests get deterministic providers with zero network. (3) The real world *will* change under us — HF deprecated its old inference domain in 2025; a provider swap is a 20-line change instead of surgery on the pipeline. (4) The spec itself says "the point is not which model you pick — more how you design the pipeline around it." This is that design.
**Trade-offs:** one more indirection layer. Worth it — it also gave us the demo hooks (D-005).

## D-005 · Mock demo hooks: magic filenames ✅

**Decision:** In mock mode, uploaded filenames trigger scenarios: `flagme*` → SafeSearch returns LIKELY/adult (exercises the flagged path + notification), `failme*` → always-failing retryable error (exercises retry exhaustion + manual retry UI), `flaky*` → fails attempt 1, succeeds attempt 2 (exercises automatic retry), `badreq*` → permanent error (exercises fail-fast, no retries).
**Why:** The flagged-content and failure flows are core requirements, but demoing them with real APIs requires either NSFW images or induced outages. Magic filenames let a reviewer exercise every path in 30 seconds. Documented in README.
**Trade-offs:** none in production — hooks exist only in the mock provider.

## D-006 · Job status updates: polling, not WebSockets ✅

**Options:** short polling · SSE · WebSockets (socket.io)
**Decision:** Polling via TanStack Query — job list refetches every 2.5 s *only while any job is non-terminal*, job detail every 1.5 s while active, notifications every 10 s. Polling stops entirely when everything is settled.
**Why:** Jobs complete in ~5–15 s; sub-second latency buys nothing. Polling is stateless — it works through any proxy/CDN, needs no sticky sessions or Redis pub/sub fan-out when the API scales horizontally, and it degrades gracefully. WebSockets would be the *third* stateful concern (after Mongo/Redis) for a strictly cosmetic gain at this scale.
**Observed nuance (kept deliberately):** TanStack pauses interval refetching while the tab is hidden and refetches immediately on focus (`refetchOnWindowFocus`) — so background tabs cost zero requests and are never stale for more than a moment when the user returns.
**Trade-offs:** ~0.4 req/s per active user; at 10× load this is the first thing I'd swap. 🔁 Upgrade path (documented in README): SSE or socket.io backed by Redis pub/sub, emitting on job state transitions from the worker.

## D-007 · Flagged-content notification: in-app, not email ✅

**Options:** email (SMTP/Resend/SES) · in-app notification center
**Decision:** In-app: a `notifications` collection, a bell with unread count, created by the worker when a job is flagged (and on final failure — useful beyond the spec).
**Why:** Self-contained — works in docker-compose with zero third-party creds, demoable by the reviewer, no deliverability/spam-folder risk during evaluation. Email would add an external dependency to demonstrate what is architecturally the same insert-and-notify pattern.
**Trade-offs:** user must open the app to see it. 🔁 Revisit: add an email channel behind the same notification-creation seam (Resend free tier) — the write-side needs no changes.

## D-008 · Pipeline: 3 sequential steps with per-step checkpointing ✅

**Options:** monolithic single call per job · 3 sequential steps (spec) · parallelize caption ∥ labels · batch labels+safety into one GCV call
**Decision:** Three sequential steps exactly as the spec frames them (caption → labels → safety), each persisted to Mongo the moment it completes (`steps.{caption,labels,safety}` each carry status/result/error/attempts/duration).
**Why the checkpoints:** a retry — automatic or manual — **resumes from the failed step** instead of re-running (and re-paying for) completed ones. It also gives the UI a live per-step timeline and makes the pipeline idempotent per step.
**Noted but not taken:** GCV accepts LABEL_DETECTION + SAFE_SEARCH_DETECTION in a single request (halves HTTP round-trips, same quota cost), and caption ∥ labels could run concurrently (~40 % latency cut). Both rejected to keep the spec's "three sequential tasks" shape legible; both are documented scale levers.

## D-009 · Failure model: error classification + bounded retries ✅

**Decision:** Providers throw typed errors carrying `retryable`. Transient (HTTP 429, 5xx, network faults, HF 503 "model loading" cold-start) → BullMQ retries the job (3 attempts, exponential backoff, default 3 s base) — checkpoints make the re-run cheap. Permanent (4xx: bad key, model gone, malformed request) → `UnrecoverableError`, fails immediately without burning retries. Unknown errors default to *retryable* (transient until proven otherwise; a real bug still fails after 3 attempts). Final failure marks the Mongo job `failed` with the classified error, notifies the user, and unlocks the **Retry** button (fresh attempt budget, resumes from checkpoint). Finality is computed *inside the worker handler* (`attempt >= max || !retryable`) rather than trusting queue event semantics — deterministic and unit-testable. A `QueueEvents` reconciler additionally catches stalled-job deaths (worker killed mid-job twice) so no job is ever stuck `processing` forever.
**Why:** This is the part of the system most likely to be probed in review ("how are failures handled?") — and HF cold starts make transient failure the *normal* case, not the edge case.

## D-010 · Repo shape: one server package, two entrypoints ✅

**Options:** separate api/ and worker/ packages · npm workspaces + shared lib · one package, two entrypoints
**Decision:** `server/` is a single package with `src/api/index.ts` and `src/worker/index.ts`; one Docker image, two start commands. `web/` is a separate Vite app baked into the API image at build time.
**Why:** API and worker genuinely share models, config, storage, and provider code. Separate packages would force publishing/workspace tooling for zero gain at this size; duplicating the shared code would be worse. One image also halves the build matrix and guarantees api/worker version lockstep in deploys.
**Trade-offs:** worker image carries express (a few MB of dead weight). 🔁 Split when dependency sets diverge materially or teams own them separately.

## D-011 · Language & tooling: TypeScript, tsx runtime, Vitest ✅

**Options:** JS+ESM · TS compiled (tsc/esbuild) · TS with tsx runtime
**Decision:** TypeScript everywhere, run with `tsx` directly (no build step for the server), `tsc --noEmit` as the CI typecheck gate, Vitest for tests, ESLint (flat config, typescript-eslint) + Prettier.
**Why:** Type safety across the api/worker/model seams catches contract drift at write time; tsx removes the compile-output-Docker dance entirely (source in, run). Vitest over Jest: native ESM/TS support, no transform config.
**Trade-offs:** tsx in production trades a few ms of startup for build-pipeline simplicity — right trade at this scale.

## D-012 · Flagged rule: only LIKELY / VERY_LIKELY flag ✅

**Decision:** A job is `flagged: true` iff any SafeSearch category (adult, spoof, medical, violence, racy) returns `LIKELY` or `VERY_LIKELY`. `POSSIBLE` does **not** flag. All category likelihoods are stored regardless; flagged categories are listed on the job.
**Why:** Spec-literal: "returns LIKELY or VERY_LIKELY for any category". POSSIBLE-flagging would be a stricter policy choice — noted as a one-line threshold change, kept out to match the written requirement.

## D-013 · Image serving: authenticated API stream (fetch → blob in UI) ✅

**Options:** public URLs · presigned URLs · API streams bytes after ownership check
**Decision:** `GET /api/jobs/:id/image` checks JWT + ownership, then streams the bytes from storage. The SPA fetches with the auth header and renders via a blob URL (an `<img src>` cannot carry an Authorization header).
**Why:** Uniform across storage drivers and environments, keeps files private by default, zero URL-signing machinery. At ≤5 MB files and interview-scale traffic, API bandwidth is a non-issue.
**Trade-offs:** every image view transits the API. 🔁 Revisit at scale: presigned GET URLs + CDN (adapter already has the seam).

## D-014 · Files as Buffers, not streams ✅

**Decision:** Uploads use multer memory storage; the storage adapter deals in Buffers end-to-end.
**Why:** Hard 5 MB cap makes worst-case memory bounded and small; the AI providers need the full buffer anyway (base64 for GCV, raw body for HF). Streaming would add complexity with zero benefit under the cap.
**Trade-offs:** raise the cap 100× and this needs revisiting (streaming multipart → storage, ranged reads).

## D-015 · Upload validation: magic bytes, not just MIME/extension ✅

**Decision:** Three gates at the API layer: multer `fileSize` limit (5 MB → HTTP 413), MIME whitelist (jpg/png/webp → clear 400), and **content sniffing of the actual bytes** (JPEG/PNG/WEBP signatures) — a renamed `.txt` → `.jpg` is rejected regardless of claimed type. Implemented as a 20-line zero-dependency util (unit-tested) instead of pulling `file-type` (ESM/CJS friction, transitive surface).
**Why:** "Enforce at the API layer, not just the frontend" is an explicit requirement; extensions and Content-Type headers are attacker-controlled.

## D-016 · bcryptjs over native bcrypt ✅

**Why:** Pure-JS — no node-gyp/musl native build in Alpine Docker images, deterministic `npm ci` everywhere. ~2× slower hashing at cost 12 (~80 ms) is irrelevant at login frequency. Argon2id would be the stronger KDF but has the same native-build friction.

## D-017 · HTTP client: native fetch, no axios ✅

**Why:** Node ≥ 18 ships stable fetch/AbortSignal.timeout — both AI providers are simple POSTs with timeouts. One less dependency, no interceptor magic to reason about.

## D-018 · Enqueue failure at upload time → job marked `failed`, not HTTP 500 ✅

**Decision:** Upload does: store file → create job (`pending`) → enqueue → 201. If the *enqueue* throws (Redis blip), the job is marked `failed (QUEUE_ENQUEUE_FAILED)` and the 201 still returns — the UI's existing Retry button re-enqueues it.
**Why:** The user's file is already safely stored; failing the whole request would force a re-upload to recover from a transient queue hiccup. The failure is visible, honest, and self-serviceable. (Mongo-down, by contrast, *does* 500 — there is nothing durable to point at yet.)

## D-019 · Job identity: Mongo ObjectId is the public job ID ✅

**Why:** One ID end-to-end (DB, queue payload, API, UI) — no UUID↔ObjectId mapping table. ObjectIds leak creation time; acceptable for this product (they're only visible to their owner).

## D-020 · Bounded queue operations (found during testing) ✅

**Context:** ioredis *buffers* commands while Redis is unreachable instead of failing them. Unbounded, that turns "Redis is down" into hung HTTP requests (upload would block forever awaiting `queue.add`) and a hung health endpoint.
**Decision:** Every API-side queue interaction is wrapped in a timeout: enqueue 5 s → the upload degrades to a `failed (QUEUE_ENQUEUE_FAILED, retryable)` job per D-018; health ping 1.5 s → reports `redis: false` instead of stalling probes.
**Why it matters:** This came out of actually exercising the Redis-less failure mode (standalone harness) rather than assuming the happy path — the exact class of failure the evaluation asks about.

## D-021 · Zero-infra dev harness: in-memory Mongo + inline queue driver ✅

**Decision:** `scripts/dev-standalone.ts` boots the real API with an in-memory MongoDB and `QUEUE_DRIVER=inline` — a ~25-line queue-module driver that runs the actual worker pipeline in-process (same processor, same error classification and finality; only the transport is skipped: cross-process delivery, persistence, backoff pacing). With the mock AI provider that makes the *entire* product — upload → pipeline → completed/flagged/failed → notifications → manual retry — runnable with zero infrastructure.
**Why:** UI iteration speed, and honest self-QA: the full flow can be exercised in a browser before Docker/deploy exist. The driver is a transport swap behind the same `enqueueProcessingJob` seam, not a second queue implementation.
**Boundary:** dev-only by default and convention — compose, k8s, and every deploy target run `bullmq`. Setting `QUEUE_DRIVER=inline` in a real deployment would silently serialize processing into API processes; the env default and docs guard against that.

## D-022 · SafeSearch results render only for a completed safety step ✅

**Context:** Mongoose materializes empty nested paths as `{}` (truthy) — the UI initially rendered an all-UNKNOWN safety matrix for jobs whose safety step never ran. Caught during browser QA.
**Decision:** Result sections in the detail view are gated on the *step's* status, not on data truthiness. Step status is the single source of truth for "did this produce results".

## D-023 · Caption model: hosted VLM via HF router, not BLIP (forced by reality) ✅

**Context:** The spec suggests `Salesforce/blip-image-captioning-base` on the Hugging Face Inference API. Verified empirically during key wiring: HF has retired task-specific serverless image-to-text entirely — the hub reports **zero** `image-to-text` models served by `hf-inference`, and calls return `"Model not supported by provider hf-inference"`. The spec anticipates exactly this ("the point is not which model you pick — more how you design the pipeline around it").
**Decision:** Keep the Hugging Face Inference surface (same token, same free tier) but caption through the router's OpenAI-compatible `/v1/chat/completions` with a hosted vision-language model. Default: `google/gemma-3-4b-it` — probed as available on this account, small/fast, answers cleanly without reasoning preambles (Qwen-VL variants weren't enabled for the account; GLM-4.5V returned empty content under tight token budgets).
**Why it validates the architecture:** the swap touched one provider file (~30 lines) and two env defaults; pipeline, worker, retries, tests, and UI were untouched. This is precisely the churn the provider seam (D-004) was designed to absorb. `HF_CAPTION_MODEL` / `HF_CAPTION_URL` stay env-swappable for the next time the provider landscape shifts.
**Trade-offs:** a 4B instruct VLM captions differently than BLIP (usually better); free-tier router credits are finite (fine for review-scale traffic).

---

# Deliberately not built (and why)

| Cut | Why | Revisit when |
|---|---|---|
| Email notifications | External SMTP dependency + deliverability risk during review; in-app channel demonstrates the same architecture (D-007) | Real users exist — add behind the same seam |
| WebSockets / SSE | Cosmetic gain at 5–15 s job durations; polling is stateless and scale-friendly (D-006) | Sub-second status UX matters or polling load hurts |
| Refresh-token rotation / revocation | 24 h expiry bounds the risk; meaningful only with real accounts (D-002) | Production auth |
| Presigned URLs + CDN for images | API streaming is fine at this scale (D-013) | Image bandwidth becomes measurable |
| Content-hash dedupe (skip AI for identical uploads) | Real quota saver, but optimization before correctness during a 48 h window | Quota costs money at real volume |
| GCV feature batching / step parallelism | Spec explicitly frames three *sequential* tasks (D-008) | Latency SLOs appear |
| Kubernetes as the primary deploy | Docker-compose + PaaS covers the rubric; manifests provided as bonus only | Real multi-node ops |
| Admin/moderation UI for flagged content | Out of spec scope | Trust & safety workflows exist |
| E2E browser tests (Playwright) | Unit tests on pipeline/retry are the spec's stated bar; E2E rig costs hours | CI budget grows |
| npm workspaces / monorepo tooling | Two packages with zero shared-package needs (D-010) | Shared libs emerge |
