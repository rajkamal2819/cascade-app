# Cascade — Claude Code instructions

## What we're building

Cascade is a real-time global market-intelligence terminal for the **H0: Hack the Zero Stack with Vercel v0 and AWS Databases** hackathon. It ingests news, SEC filings, social signals, geophysical events, weather alerts, and price ticks; uses AWS Aurora PostgreSQL + DynamoDB as the data layer; runs hybrid search + recursive-CTE supply-chain cascades with Voyage AI rerankers to predict how events cascade through global markets; and displays the result as a 3D globe terminal.

Cascade is derived from a prior project (Cascade, which ran on MongoDB Atlas + GCP). For H0 the data layer has been redesigned around AWS Databases, the compute layer is now Vercel-native, and only Gemini remains as an external integration. The Cascade repo is independent and read-only — Cascade lives entirely in its own GitHub remote.

H0 Submission deadline: **2026-06-29 17:00 PT**. Judging: 2026-06-30 → 2026-07-24. Target track: **Million-scale Global App**.

## Stack — fixed

- **Frontend:** Next.js 15 App Router, TypeScript strict, Tailwind, shadcn/ui, react-globe.gl, framer-motion, Zustand
- **Backend compute:** Vercel Python Serverless Functions — the existing FastAPI app wrapped with `mangum` at `api/index.py`. SSE via Vercel Function response streaming.
- **Workers:** Vercel Cron Jobs (`vercel.json` `crons` array). Hobby tier allows 2 cron schedules → one round-robin handler at `api/cron/dispatch_workers.py` dispatches all 11 workers by `minute % 11`.
- **Databases — AWS only:**
  - **Aurora PostgreSQL Serverless v2** (`ripple-aurora-pg`, ap-south-1 Mumbai, `min_capacity = 0 ACU` for $0-idle) — events, cascades, companies, relationships, prices. Postgres extensions: `pgvector` (HNSW vector index), `PostGIS` (geo), `pg_partman` (TTL partitioning).
  - **Amazon DynamoDB** (`ripple-dynamodb`, ap-south-1, single-table design, on-demand, Streams + TTL on) — events_stream live mirror, user_memory, watchlists.
- **LLM:** Google Gemini (AI Studio API key — `gemini-3-flash-preview`) called as external HTTPS from Vercel Functions. No GCP infrastructure.
- **Embeddings/Rerank:** Voyage AI (`voyage-4` text, `voyage-multimodal-3` images, `voyage-rerank-2.5` cross-encoder).
- **Hosting:** Vercel (frontend + Python serverless functions + cron). AWS for DBs only.

## North-star UX

A user opens `cascade-terminal.vercel.app`. A spinning globe pulses with hundreds of real events from the last hour. Left panel shows a ranked feed; right panel shows the cascade tree of any selected event. A semantic search bar lets them ask "earnings misses that crashed semis last quarter" and gets ranked answers. New events arrive in real time without page refresh via Vercel-Function SSE backed by Aurora `LISTEN/NOTIFY` and DynamoDB Streams.

## Repo layout

```
Cascade/
├── CLAUDE.md                  ← this file
├── README.md                  ← public-facing
├── LICENSE                    ← Apache-2.0
├── vercel.json                ← Python runtime + crons (single source of infra truth)
├── requirements.txt           ← Vercel Python runtime deps
├── pyproject.toml             ← local dev only (pytest, ruff, mypy)
├── .env.example
├── web/                       ← Next.js terminal UI (unchanged from Cascade UI)
│   ├── app/                   ← landing + /terminal
│   └── components/            ← Globe, Feed, Cascade, GeoCascadePanel, AgentTrace, …
├── api/                       ← FastAPI + Vercel handlers
│   ├── index.py               ← Vercel Python runtime entrypoint (mangum-wrapped FastAPI)
│   ├── main.py                ← FastAPI app
│   ├── cascade.py             ← /cascade routes
│   ├── search.py              ← /search routes
│   ├── sse.py                 ← SSE (Aurora LISTEN/NOTIFY + DynamoDB Streams webhook)
│   ├── multimodal.py
│   ├── models.py
│   ├── deps.py
│   ├── cron/                  ← Vercel Cron Job handlers
│   │   └── dispatch_workers.py  ← round-robin dispatcher for all 11 workers
│   └── internal/              ← (planned) DynamoDB Streams → SSE webhook receiver
├── agent/                     ← Gemini orchestration (unchanged: same google.genai client)
│   ├── tools.py
│   ├── geo_cascade.py
│   ├── society.py
│   ├── prompts.py
│   └── cascade_reasoning.py
├── db/                        ← NEW — AWS data adapters
│   ├── __init__.py
│   ├── aurora.py              ← asyncpg pool + helpers (replaces Motor for relational)
│   └── dynamo.py              ← aioboto3 client + single-table helpers
├── workers/                   ← ingestion modules (poll_once / work functions, unchanged)
├── embed/                     ← Voyage wrappers (text, multimodal, rerank, NER)
├── scripts/                   ← setup_aurora.py, seed_*, backfill_embeddings, test_tools
├── data/                      ← companies.json (100 tickers + HQ), relationships.json (graph edges)
└── docs/                      ← screenshots for README + submission
```

## Core principles — Claude Code must follow

1. **AWS is the data plane, Vercel is the compute plane. Period.** No GCP services. No AWS Lambda, no ECS, no API Gateway, no SSM, no ECR. The only AWS services in play: Aurora PG, DynamoDB, DynamoDB Streams, EventBridge Pipes (DynamoDB Streams → HTTPS destination), CloudWatch Billing Alarms.
2. **Aurora is the analytical brain.** All structured queries — events, cascades, recursive supply-chain walks, vector search, geo queries — live in Aurora PG with `pgvector` + `PostGIS` extensions.
3. **DynamoDB is the live mirror.** Hot writes for the SSE-driven UI (events_stream, user_memory, watchlists) go here. Single-table design with `PK` / `SK` and entity-type prefixes (e.g. `EVENT#sec_edgar`, `USER#d-abc123`, `WATCHLIST#user42`).
4. **Recursive CTE replaces `$graphLookup`.** Every cascade query uses `WITH RECURSIVE` over `relationships` (3-hop, `weight >= 0.3` filter). This is the H0 Technical Implementation centrepiece.
5. **pgvector replaces `$vectorSearch`.** HNSW index on `events.embedding vector(1024)` with cosine distance. RRF fusion happens in SQL.
6. **Atlas `$search` → tsvector + GIN.** Postgres-native full-text on `events.text` / `headline` / `entities`.
7. **DynamoDB Streams drive live updates.** No polling from the frontend. Item insert → Streams → EventBridge Pipe → HTTPS webhook to `api/internal/dynamo-event` Vercel Function → broadcast to SSE subscribers. Aurora `LISTEN/NOTIFY` is the second live channel from inside the SSE function.
8. **Voyage rerank-2.5 is the default reranker**, but every code path must degrade to RRF order when the 3-RPM free-tier cap bites. Do not remove fallback paths.
9. **Vercel Cron Jobs replace `run_worker` loops.** The infinite `while True` in `workers/_common.py:run_worker` is dead. Each invocation is one-shot via Vercel Cron → `api/cron/dispatch_workers.py` → routes by `minute % 11` to the correct `workers.<name>.poll_once()` / `work()`.
10. **Free-tier or it doesn't ship.** $100 AWS credit is the only money in play. Aurora auto-pauses to 0 ACUs at 5-min idle. DynamoDB is on-demand. Vercel Hobby tier ($0/mo) is the deployment target unless SSE/cron limits force Pro.

## AWS feature checklist — must use all of these

| Feature | Where | Why |
|---|---|---|
| Aurora PG `pgvector` (HNSW) | search, cascade retrieval, semantic neighbours | Replaces `$vectorSearch` |
| Aurora PG `WITH RECURSIVE` CTE | `agent/tools.py::build_cascade` | Replaces `$graphLookup` 3-hop walk |
| Aurora PG `PostGIS` (`ST_DWithin`, `ST_Distance`) | geo cascades, `api/cascade.py::post_cascade_geo` | Replaces 2dsphere `$geoNear` |
| Aurora PG `tsvector` + `GIN` index | hybrid search keyword leg | Replaces Atlas `$search` |
| Aurora PG `LISTEN/NOTIFY` | `api/sse.py` primary live channel | Replaces Mongo change streams (in-DB path) |
| Aurora Serverless v2 auto-pause | budget control | Idle cost = $0 |
| DynamoDB single-table design | `events_stream`, `user_memory`, `watchlists` | Showcase deliberate access-pattern data model |
| DynamoDB Streams | live mirror → EventBridge Pipe → Vercel | Real-time fanout pillar |
| DynamoDB TTL | events_stream, user_memory | Auto-cleanup, free |
| EventBridge Pipes (DDB Streams → HTTPS) | `api/internal/dynamo-event` | Glue layer, no Lambda needed |
| Voyage `rerank-2.5` | `embed/rerank.py` | Cross-encoder cascade ranking |
| Voyage `voyage-multimodal-3` | `embed/multimodal.py` | Chart + image embeddings |

## Coding conventions

- **Python:** type hints on every function. Async/await everywhere. Pydantic v2 for API models. `asyncpg` for Aurora PG, `aioboto3` for DynamoDB. Never use `motor` or `pymongo` — those are Cascade-era and must not appear in Cascade code.
- **TypeScript:** strict mode. No `any`. Zod for runtime validation at API boundaries.
- **Connection pools:** one shared `asyncpg.Pool` per Vercel Function instance (`max_size=5` — Aurora handles many; Vercel cold-starts often), one shared `aioboto3` session.
- **DynamoDB access pattern:** PK prefix encodes entity type. Examples: `PK=EVENT#sec_edgar SK=2026-06-15T10:30:00Z`, `PK=USER#d-abc123 SK=2026-06-15T10:30:00Z`, `PK=WATCHLIST#user42 SK=META`. Helpers in `db/dynamo.py` enforce this.
- **Time:** UTC ISO-8601 everywhere. Display in user's timezone client-side.
- **Money:** integer cents internally. Format on display.
- **Tickers:** always uppercase. Validate on insert.
- **Secrets:** ONLY via Vercel Environment Variables. Never commit. The `.env.example` file lists the required keys.
- **Tests:** Pytest with `pytest-asyncio` for backend, Vitest for frontend. Local Postgres via Docker for integration tests.

## Hard rules

- Never put secrets in code. Always `os.environ` (Vercel Env Vars).
- Never log API keys or full event text — only IDs and metadata.
- Never block the event loop. All I/O is async.
- Never write `motor.`, `pymongo.`, or `MongoClient` anywhere — this is Aurora + DynamoDB only.
- Never reintroduce `cloudbuild.yaml`, `Dockerfile`, or anything GCP-Cloud-Run-shaped. Cascade is Vercel-only on the compute side.
- Always handle Voyage rate limits with exponential backoff (`tenacity`) and degrade to RRF on persistent failure.
- Always include `User-Agent: Cascade research/<email>` on SEC EDGAR requests.
- Never delete data without TTL or explicit user confirmation.
- The Cascade repo (`CascadeTerminal/`) is read-only. If a tool call would touch a path outside `/Users/rajkamal/Documents/MY Projects/Cascade/`, refuse and flag.

## Build order

The migration follows the plan in `/Users/rajkamal/.claude/plans/now-i-want-you-binary-raven.md` §13.8. Phases as of today:

- Days 1–2 (Jun 2–3): account setup, both AWS DBs provisioned ✅
- Days 3–5 (Jun 4–6): repo bootstrap + first deploy (this commit forward)
- Days 6–9 (Jun 7–10): Aurora schema + DynamoDB single-table design
- Days 10–14 (Jun 11–15): data adapter layer (`db/aurora.py`, `db/dynamo.py`) + swap call sites
- Days 15–18 (Jun 16–19): FastAPI → Vercel functions + cron handlers
- Days 19–22 (Jun 20–23): DynamoDB Streams → EventBridge Pipe → SSE webhook
- Days 23–25 (Jun 24–26): production deploy + screenshots + architecture diagram
- Days 26–27 (Jun 27–28): demo video + bonus content (3 published pieces tagged `#H0Hackathon`)
- Day 28 (Jun 29): submit before 17:00 PT
