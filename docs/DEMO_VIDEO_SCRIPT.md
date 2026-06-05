# Demo video re-dub script — H0 submission (≤3:00)

Reuse the existing Cascade hackathon footage. Replace the audio track, mute / cut frames where "MongoDB / Atlas / GCP" appears on-screen, and append a fresh 30-second AWS architecture panel at the end.

## Per-frame guidance

| Time | On-screen (existing footage) | New voiceover |
|---|---|---|
| 0:00–0:15 | Globe boot sequence, terminal lights up | "Cascade — built end-to-end on Vercel and AWS Databases for the H0 Hack the Zero Stack. When a single headline moves markets, Cascade tells you which 30 stocks move next." |
| 0:15–0:35 | Feed populating with events; user clicks a Booking Holdings event | "Live news, SEC filings, social signals — all ingested by Vercel Cron Jobs into our Aurora PostgreSQL Serverless database. Click any event …" |
| 0:35–1:00 | Cascade panel renders with downstream tickers + 3D graph nodes | "… and Cascade walks the supply-chain graph three hops deep — that's a single Postgres `WITH RECURSIVE` CTE over our 1149-edge relationships table, replacing Mongo `$graphLookup` with native SQL." |
| 1:00–1:30 | Society panel — Critic / Predictor / Memory / ELI5 cards stream in | "Four Gemini sub-agents reason in parallel: Critic flags weak edges, Predictor projects 24-hour direction, Memory grounds against this device's last 20 cascades — pulled from DynamoDB in single-digit milliseconds — and ELI5 explains the cascade for a curious twelve-year-old." |
| 1:30–2:00 | Search bar — type "Taiwan chip supply" — hybrid results | "Search is hybrid: pgvector cosine similarity, Postgres `tsvector` full-text, fused via Reciprocal Rank Fusion, reranked by Voyage rerank-2.5. Three retrieval modes in one query — all inside Aurora." |
| 2:00–2:25 | Geo-Cascade panel — tickerless geopolitical event, arcs on globe | "For tickerless events — geopolitics, hurricanes, regulatory rulings — Gemini infers affected regions and sectors. We validate every latitude, longitude, and ticker against our Aurora company universe so hallucinated symbols never reach the UI." |
| 2:25–3:00 | **NEW slide 1:** AWS architecture diagram (from README mermaid) | "Two AWS databases, used deliberately: Aurora PostgreSQL for the analytical plane — pgvector, PostGIS, recursive CTEs, LISTEN/NOTIFY live push — and DynamoDB single-table on-demand for the real-time mirror, with Streams fanning out via EventBridge to Vercel Functions. Everything provisioned through the Vercel Marketplace AWS Databases integration. Compute is 100% Vercel. Idle Aurora cost: zero. Thank you." |

## Final 30-second AWS panel — what to show

A single screen with two columns:

**Aurora PostgreSQL Serverless v2** (`ripple-aurora-pg`, ap-south-1)
- `companies` — ticker + `PostGIS geography(POINT, 4326)` + GIST index
- `relationships` — directed graph, `weight` real, three-column PK
- `events` — `pgvector(1024)` + HNSW + tsvector + GIN, TTL via `ingested_at`
- `cascades` — `jsonb` cache (society) + text (narrative)
- LISTEN/NOTIFY trigger on events INSERT

**DynamoDB on-demand** (`ripple-dynamodb`, single-table, ap-south-1)
- `PK = EVENT#<id>` / `SK = <timestamp>` — events_stream mirror, Streams ON
- `PK = USER#<device_id>` / `SK = <viewed_at>` — cascade-view history, TTL 30d
- `PK = WATCHLIST#<user_id>` / `SK = <ticker>` — pinned tickers
- TTL attribute, on-demand billing, no GSI needed

## Recording notes

- Replace audio track entirely; don't try to dub over the old voice.
- Wherever "MongoDB" / "Atlas" / "Cloud Run" appears on a screen capture, cut the frame or zoom in past the text.
- Voiceover pacing: ~155 words per minute keeps the 460-word script under 3 minutes.
- Open with Vercel + AWS framing; close with explicit "Aurora PostgreSQL + DynamoDB" callout — H0 rules require the demo explain *which* AWS Databases are used.
- Upload public (not unlisted) to YouTube. Caption: `#H0Hackathon`.
