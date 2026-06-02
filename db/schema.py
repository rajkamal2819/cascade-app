"""
Aurora PostgreSQL schema DDL.

Executed by `/api/admin/bootstrap` (protected by CRON_SECRET) on a fresh
Aurora cluster. Idempotent — every statement uses IF NOT EXISTS.

Extensions:
    - vector (pgvector)  ← semantic recall on events.embedding
    - postgis            ← geographic event detection via companies.hq_coords

Tables:
    - companies        — ticker registry + HQ point geometry
    - relationships    — directed graph (supplier/customer/peer/sector/derivative)
    - events           — ingested events (TTL'd at app level via ingested_at < now()-14d)
    - cascades         — cached cascade tree + society sub-doc per event

Indexes:
    - HNSW on events.embedding (cosine)
    - GIST on companies.hq_coords (geographic)
    - btree on events.published_at, events.ingested_at
    - GIN on events.tickers (array contains)
"""

DDL = [
    "CREATE EXTENSION IF NOT EXISTS vector",
    "CREATE EXTENSION IF NOT EXISTS postgis",
    """
    CREATE TABLE IF NOT EXISTS companies (
        ticker        TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        sector        TEXT,
        industry      TEXT,
        hq_country    TEXT,
        hq_coords     geography(POINT, 4326),
        market_cap    NUMERIC,
        exchange      TEXT,
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS relationships (
        from_ticker   TEXT NOT NULL REFERENCES companies(ticker) ON DELETE CASCADE,
        to_ticker     TEXT NOT NULL REFERENCES companies(ticker) ON DELETE CASCADE,
        type          TEXT NOT NULL,
        weight        REAL NOT NULL CHECK (weight >= 0 AND weight <= 1),
        source        TEXT,
        PRIMARY KEY (from_ticker, to_ticker, type)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS events (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        source_type   TEXT NOT NULL,
        source_id     TEXT,
        title         TEXT NOT NULL,
        body          TEXT,
        url           TEXT,
        published_at  TIMESTAMPTZ NOT NULL,
        ingested_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        tickers       TEXT[] NOT NULL DEFAULT '{}',
        sectors       TEXT[] NOT NULL DEFAULT '{}',
        impact        REAL DEFAULT 0,
        sentiment     REAL DEFAULT 0,
        embedding     vector(1024),
        UNIQUE (source_type, source_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS cascades (
        event_id      UUID PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
        root_tickers  TEXT[] NOT NULL,
        built_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        walk          JSONB NOT NULL,
        society       JSONB,
        narrative     TEXT
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_events_published ON events (published_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_events_ingested ON events (ingested_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_events_tickers ON events USING GIN (tickers)",
    "CREATE INDEX IF NOT EXISTS idx_events_sectors ON events USING GIN (sectors)",
    "CREATE INDEX IF NOT EXISTS idx_companies_geo ON companies USING GIST (hq_coords)",
    "CREATE INDEX IF NOT EXISTS idx_relationships_from ON relationships (from_ticker)",
    "CREATE INDEX IF NOT EXISTS idx_relationships_to ON relationships (to_ticker)",
    # HNSW on the embedding column. m=16 / ef_construction=64 are pgvector defaults.
    """
    CREATE INDEX IF NOT EXISTS idx_events_embedding_hnsw
    ON events USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64)
    """,
]


# Recursive cascade walk — the H0 Technical Implementation centerpiece.
# Replaces MongoDB's $graphLookup with a Postgres WITH RECURSIVE CTE.
CASCADE_WALK_SQL = """
WITH RECURSIVE walk AS (
    SELECT
        r.from_ticker      AS root,
        r.from_ticker      AS path_from,
        r.to_ticker        AS ticker,
        r.type,
        r.weight           AS edge_weight,
        r.weight           AS cumulative_weight,
        1                  AS hop
    FROM relationships r
    WHERE r.from_ticker = ANY($1::TEXT[])
      AND r.weight >= $3

    UNION ALL

    SELECT
        w.root,
        r.from_ticker,
        r.to_ticker,
        r.type,
        r.weight,
        w.cumulative_weight * r.weight,
        w.hop + 1
    FROM walk w
    JOIN relationships r ON r.from_ticker = w.ticker
    WHERE w.hop < $2
      AND r.weight >= $3
      AND r.to_ticker <> w.root
)
SELECT
    root,
    path_from,
    ticker,
    type,
    edge_weight,
    cumulative_weight,
    hop
FROM walk
ORDER BY hop ASC, cumulative_weight DESC
LIMIT 500
"""
