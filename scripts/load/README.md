# Load and scalability tests (Part 21)

Local, indicative measurements — not CI. Results and decisions are recorded in
[docs/backend/21-PERFORMANCE-AND-SCALABILITY.md](../../docs/backend/21-PERFORMANCE-AND-SCALABILITY.md).

**Never point these scripts at a real database.** The seed inserts synthetic tenants and about
3 million rows. Use a throwaway Compose project with its own volumes:

```bash
# 1. A separate stack: own project name, container names, ports, volumes and network,
#    no .env (throwaway secrets only): scripts/load/perf.compose.yml.
export PERF_JWT_ACCESS=$(openssl rand -hex 32) PERF_JWT_REFRESH=$(openssl rand -hex 32)
export PERF_WEBHOOK_SECRET=$(openssl rand -hex 24)
docker compose -p flowforge-perf -f docker-compose.yml -f scripts/load/perf.compose.yml --profile full \
  up -d --build --scale worker=2

# 2. Seed 1M runs (≈ 2–4 min) and inspect the hot query plans
docker exec -i ffp-postgres psql -U flowforge -d flowforge -v runs=1000000 < scripts/load/seed-perf.sql
docker exec -i ffp-postgres psql -U flowforge -d flowforge < scripts/load/explain-hot-queries.sql

# 3. Webhook intake: 50 req/s for 2 min across both API instances (k6 inside the network)
docker run --rm -i --network ffp-network -e WEBHOOK_TEST_SECRET=$PERF_WEBHOOK_SECRET \
  -e TARGETS=http://api:3000,http://api2:3000 grafana/k6 run - < scripts/load/webhook-intake.js

# 4. 1 000 manual runs through both APIs, executed by the workers; then verify
docker run --rm -i --network ffp-network -e TARGETS=http://api:3000,http://api2:3000 \
  grafana/k6 run - < scripts/load/manual-runs.js        # prints workspace=<id>
docker exec -i ffp-postgres psql -U flowforge -d flowforge -v ws=<id> < scripts/load/check-runs.sql

# 5. Clean up everything the stack created
docker compose -p flowforge-perf -f docker-compose.yml -f scripts/load/perf.compose.yml --profile full down -v
```

| File | Purpose |
| --- | --- |
| `seed-perf.sql` | 100 workspaces (one "hot" with 40 % of runs), 2 000 workflows, 1M runs over 120 days, 2M steps, 300k deliveries; a TEST-provider trigger (`load.event` / `load-test`) for the intake test |
| `explain-hot-queries.sql` | `EXPLAIN (ANALYZE, BUFFERS)` of run list (first page, deep keyset page, filters), step list, membership check, trigger match, dashboard, sweeper, retention batches, and run deletion with/without the `retryOfRunId` index |
| `webhook-intake.js` | k6: signed TEST webhooks at a constant arrival rate (`RATE`, `DURATION`); threshold p95 < 200 ms |
| `manual-runs.js` | k6: registers a user, publishes a `util.log` workflow, starts `COUNT` runs round-robin across `TARGETS` |
| `check-runs.sql` | Status counts, duplicate-execution check (attempts ≠ 1), queue wait / run time percentiles, drain time |

The TEST webhook provider and `THROTTLE_ENABLED=false` only work outside production, so the
perf stack runs the production image with `NODE_ENV=test`. Throttling is off because all k6
traffic comes from one IP (the webhook limit is 600/min per provider and IP).
