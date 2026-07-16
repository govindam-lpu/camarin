# AI-Powered Media Processing Microservice

> **Status: under construction** — full documentation (architecture diagram, env table, deploy guide, scalability analysis) lands with the final commit. See [DECISIONS.md](DECISIONS.md) for the running decision log.

Upload an image → it's stored durably, queued, and processed asynchronously by a worker running a 3-step AI pipeline (caption → labels → safety check) → results are queryable in a live-updating UI.

## Quickstart (local, zero config)

```bash
docker compose up --build
# open http://localhost:8080  — sign up, upload an image, watch the pipeline run
```

Runs in **mock AI mode** by default (no API keys needed). To use the real AI providers, set `AI_PROVIDER=real`, `HF_TOKEN`, and `GCV_API_KEY` — see `.env.example`.
