# Kubernetes manifests (bonus)

Plain-YAML manifests showing how this system maps onto k8s. The docker-compose file is
the canonical local runner; these exist to demonstrate the production shape:

- **api** — Deployment (2 replicas) + Service. Stateless (JWT, no sessions): scale freely.
- **worker** — Deployment (2 replicas), no Service (consumes the queue, serves nothing).
  Scale this dimension for throughput; the natural autoscaling trigger is **queue depth**
  (KEDA's Redis scaler pointed at the BullMQ wait list) rather than CPU.
- **config/secrets** — non-secret env in a ConfigMap; keys in a Secret (template provided,
  values intentionally absent).
- **Mongo & Redis are not manifested**: in any real deployment those are managed services
  (Atlas / managed Redis). Running stateful databases inside the cluster is a deliberate
  non-goal here — see DECISIONS.md.

```bash
kubectl apply -f k8s/namespace.yaml
kubectl -n media-pipeline create secret generic app-secrets \
  --from-literal=JWT_SECRET=$(openssl rand -hex 32) \
  --from-literal=MONGO_URI='mongodb+srv://…' \
  --from-literal=REDIS_URL='rediss://…' \
  --from-literal=HF_TOKEN='hf_…' \
  --from-literal=GCV_API_KEY='AIza…' \
  --from-literal=S3_ACCESS_KEY_ID='…' \
  --from-literal=S3_SECRET_ACCESS_KEY='…'
kubectl apply -f k8s/
```

Note: `STORAGE_DRIVER=s3` is required on k8s — pods share no disk (same reasoning as the
PaaS deploy, DECISIONS.md D-003).
