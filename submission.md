## Inspiration

When a chip-plant fire in Taiwan or an oil-tanker stuck in the Red Sea hits the wire, hundreds of stocks reprice within minutes. But the link between *that headline* and the *thirty companies it's about to hit* lives in an analyst's head — scattered across Bloomberg terminals, Discord servers, SEC filings, and weather alerts. By the time a human stitches it together, the move is gone. We wanted to see whether **two AWS databases, used deliberately, could be that connective tissue**.

## What it does

Cascade is a real-time global market intelligence terminal. It ingests live news, SEC filings, social signals, and price ticks; walks supply-chain graphs in real time with a Postgres `WITH RECURSIVE` CTE; reranks impacted companies with Voyage `rerank-2.5`; mirrors the live event firehose into DynamoDB so Streams can fan it out to every connected browser via SSE; and — for tickerless events like geopolitics, weather, and macro shocks — asks Gemini to infer the affected regions, sectors, and transmission mechanism, then plots structured coordinates onto a 3D globe.

Four Gemini sub-agents — Critic, Predictor, Memory, ELI5 — reason about each cascade in parallel. Memory is grounded in the user's last 20 cascade views, pulled by `device_id` from DynamoDB single-digit-millisecond. Every UI surface lights up the moment Aurora's `LISTEN/NOTIFY` trigger fires.

## How we built it

**The two-database split is the architecture.**

- **Amazon Aurora PostgreSQL Serverless v2** (`min_capacity = 0 ACU` — idle cost is literally $0) holds the analytical plane: events with `pgvector(1024)` HNSW embeddings, a 1149-edge `relationships` graph, `companies` with `PostGIS geography(POINT, 4326)`, and `cascades` cache (`jsonb` for society + `text` for narrative). Three Postgres features compose into one cascade query: `pgvector` semantic recall, `tsvector` + `GIN` keyword recall fused via Reciprocal Rank Fusion, and a `WITH RECURSIVE` 3-hop walk over `relationships` with `weight ≥ 0.3` filter. One trigger on `events` INSERT calls `pg_notify('events_new', NEW.id::text)` — the SSE Vercel Function holds an `asyncpg` connection open with `LISTEN` and re-emits over the wire.

- **Amazon DynamoDB** (on-demand, single-table) holds the real-time mirror: `events_stream` for live fanout, `USER#<device_id>` for cascade-view history (TTL 30d), `WATCHLIST#<user_id>` for pinned tickers. Three logical entities, one table, one resource bill. **DynamoDB Streams → EventBridge Pipe → HTTPS webhook → Vercel Function** is the AWS-native live path that runs alongside the Aurora `LISTEN/NOTIFY` channel — two live pillars feeding the same SSE.

Compute is **all-Vercel**: the FastAPI app runs as a Python Serverless Function via `mangum`, eleven ingestion workers run as **Vercel Cron Jobs**, and the DynamoDB Streams handler is one more Vercel Function. AWS credentials never live in code or env vars — we use the **Vercel Marketplace AWS Databases OIDC federation**: Vercel injects an `x-vercel-oidc-token` header on every invocation, a FastAPI middleware captures it into a contextvar, and `db/_aws_creds.py` exchanges it via `STS AssumeRoleWithWebIdentity` for per-role temporary credentials. Aurora connects via IAM auth (`generate_db_auth_token`); DynamoDB connects via `aioboto3` with the same assumed-role credentials.

**Gemini (AI Studio)** is the only AI service — called as plain HTTPS from Vercel Functions, no GCP infrastructure. Four roles: cascade synthesis (severity + risk factors + summary), the agent society (Critic / Predictor / Memory / ELI5 in parallel, 15s timeout each with deterministic local fallback), and the **geo-cascade** for tickerless events (regions with lat/lon centroids range-validated to drop NaN / out-of-range hallucinations; affected tickers validated against the Aurora company universe so hallucinated symbols never escape).

**Voyage AI** powers `voyage-4` (1024-dim) document + query embeddings and `voyage-rerank-2.5` cross-encoder over the RRF-fused candidate set.

## Challenges we ran into

1. **Vercel doesn't inject the OIDC token as an env var.** It arrives as `x-vercel-oidc-token` on every HTTP request. After watching boto3 fail with `Unable to locate credentials` for an embarrassingly long time, we built a FastAPI middleware that stashes the per-request token into a `contextvars.ContextVar`, then a custom STS exchange path in `db/_aws_creds.py`. Cached per role ARN with a 13-minute TTL so 99% of requests skip the STS round-trip.

2. **Aurora Serverless v2 cold starts on the first hit after pause.** `min_capacity = 0` saves real money but the first hit after idle takes 10-15s. Solved with a deliberate warmup ping in the SSE handshake.

3. **Voyage free-tier 3 RPM cap.** Forced careful batching — we backfill embeddings 64 at a time (one Voyage call, well under cap), and we degrade the hybrid search gracefully when Voyage is rate-limited so the user always sees results.

4. **Mongo `$graphLookup` → Postgres `WITH RECURSIVE`.** The shape of the cascade response and the frontend's edge/node model assumed Mongo. Porting to a recursive CTE required us to model `cumulative_weight` (multiplicative weight across hops) and a `path_from` field for the visual edge layout. The CTE now returns the same 500-row contract the UI expects.

## Accomplishments that we're proud of

- **Zero-credential AWS access from Vercel.** Pure OIDC federation, end-to-end. No `AWS_ACCESS_KEY_ID` anywhere.
- **Idle Aurora cost is literally zero.** `min_capacity = 0 ACU` with 5-minute auto-pause. The judging window costs us under $5.
- **Aurora `LISTEN/NOTIFY` over Vercel response streaming.** A real-time push channel that traverses Aurora → asyncpg → FastAPI → SSE → browser, end-to-end.
- **Gemini geo-cascade with server-side coordinate validation.** Every lat/lon from the LLM is range-checked; every ticker is set-membership-checked against the Aurora seed universe. Hallucinated symbols and out-of-range coordinates are dropped before they reach the frontend.

## What we learned

- The Vercel Marketplace AWS Databases integration is the cleanest path to a real Vercel + AWS architecture — the storage configuration screenshot you take from the Vercel dashboard is literally the architecture diagram.
- A single-table DynamoDB design with PK prefixes (`EVENT#`, `USER#`, `WATCHLIST#`) models three entities in one resource and saves real money on a per-table cost basis.
- Postgres `WITH RECURSIVE` is a better fit for typed graph walks than Mongo `$graphLookup` — the cumulative weight is just a column, and the depth limit is a `WHERE` clause.

## What's next for Cascade

- Production cron schedules for the 11 ingestion workers via AWS EventBridge Scheduler → Vercel Function webhooks (a single Vercel Cron round-robins through them today; one webhook per worker post-Pro).
- DynamoDB Streams → EventBridge Pipe → Vercel Function webhook is wired in code and waiting on AWS Console configuration — the Aurora `LISTEN/NOTIFY` path is already live.
- Voyage `voyage-multimodal-3` for chart-image cascades (event chart → embedding → semantic neighbours).
- Aurora `TimescaleDB` extension (if compatibility verified) for OHLCV time-series; otherwise DynamoDB composite `(ticker, ts)`.

## Built with

`vercel` · `nextjs` · `typescript` · `tailwindcss` · `python` · `fastapi` · `mangum` · `asyncpg` · `aioboto3` · `pgvector` · `postgis` · `aurora` · `dynamodb` · `voyageai` · `gemini` · `react-globe.gl` · `sse-starlette` · `oidc`
