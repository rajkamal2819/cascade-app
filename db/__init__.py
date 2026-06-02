"""
db — Cascade's AWS data adapters.

Two modules:
    aurora  — asyncpg pool + pgvector + recursive-CTE helpers for Aurora PG
    dynamo  — aioboto3 client + single-table helpers for DynamoDB

Both expose function signatures that mirror the surface the Cascade codebase
called into Motor with, so the swap inside `agent/`, `api/`, and `workers/`
is mechanical (rename the import, keep the call site).
"""
