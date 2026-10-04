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

## Expanded platform (Part 27)

Results: [docs/backend/27-EXPANDED-PLATFORM-PERFORMANCE-AND-SCALABILITY.md](../../docs/backend/27-EXPANDED-PLATFORM-PERFORMANCE-AND-SCALABILITY.md).

**Query plans** — after `seed-perf.sql`, on the same throwaway database:

```bash
docker exec -i ffp-postgres psql -U flowforge -d flowforge -v deliveries=1000000 < scripts/load/seed-expanded.sql
docker exec -i ffp-postgres psql -U flowforge -d flowforge < scripts/load/explain-expanded.sql
```

A database alone is enough for this (no API/worker containers), e.g.
`docker run -d --name ff27-explain-pg -p 127.0.0.1:55437:5432 -e POSTGRES_USER=perf -e POSTGRES_PASSWORD=perf postgres:17-alpine`,
then `DATABASE_URL=postgresql://perf:perf@127.0.0.1:55437/perf npx prisma migrate deploy`, seed, explain, `docker rm -f ff27-explain-pg`.

**Distributed correctness and load** — `test/integration/expanded-scale.int-spec.ts` runs 2 API
instances, workers, 3 schedule evaluators, concurrent pollers and Gmail resolvers in one process
against the integration database and Redis, with a local HTTP test service (latency, 429s) and the
fake Google. It prints one `SCALE_METRIC {...}` line per scenario and asserts the thresholds.
Volumes are environment variables (defaults are small enough for the regular gate):

```bash
FF_SCALE_SCHEDULES=10000 FF_SCALE_HTTP_RUNS=1000 FF_SCALE_HOOK_REQUESTS=600 FF_SCALE_JIRA_REQUESTS=400 \
FF_SCALE_POLLS=200 FF_SCALE_GMAIL_WORKSPACES=6 FF_SCALE_GMAIL_MESSAGES=60 FF_SCALE_SHUTDOWN_RUNS=200 \
  npx jest --config test/jest-int.json --runInBand test/integration/expanded-scale
```

Run one scenario with `-t 'FR-27.1'` (etc.). Do not run it while other heavy work shares the
Docker VM: a contended database is measured as evaluator/intake latency.

| File | Purpose |
| --- | --- |
| `seed-expanded.sql` | 10 000 schedule workflows (30 % due at the same minute over 3 timezones, 10 % `http.poll`, 5 % inactive), 5 000 generic webhooks, 2 000 Jira/Gmail connections with subscriptions, 1 000 Jira-routed triggers, `deliveries` generic deliveries over 30 days, 1 000 poll states with full 2 000-id windows, 100 000 SCHEDULE/POLL runs |
| `explain-expanded.sql` | `EXPLAIN (ANALYZE, BUFFERS)` of the batched due-schedule claim and advance, hook lookup, delivery dedup and log pages, Jira trigger/subscription scans, Gmail mailbox lookup, poll quota and state, run list by trigger source (common and rare), delivery retention |
