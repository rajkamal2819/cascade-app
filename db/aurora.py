"""
Aurora PostgreSQL adapter — asyncpg pool with RDS IAM auth via Vercel OIDC.

Replaces the Mongo Motor singleton from Cascade. Every other module reaches
Aurora through `get_pool()` here, never by constructing its own connection.

Authentication path (production):
    1. Vercel injects `VERCEL_OIDC_TOKEN` per request.
    2. STS `AssumeRoleWithWebIdentity` exchanges it for temp creds scoped to
       `POSTGRES_AWS_ROLE_ARN` (the role the Marketplace integration created).
    3. `rds:GenerateDBAuthToken` produces a 15-min password.
    4. asyncpg connects over TLS using that password.

Pool refresh: pool is recreated if older than 13 minutes (under the 15-min
token lifetime) so long-running function instances don't accumulate stale
connections. Vercel function lifetimes are well under this in practice.
"""

from __future__ import annotations

import os
import ssl
import time
from typing import Optional

import asyncpg
import boto3

from ._aws_creds import get_aws_credentials

_pool: Optional[asyncpg.Pool] = None
_pool_created_at: float = 0.0
_POOL_TTL_SECONDS = 13 * 60


def _config() -> tuple[str, int, str, str, str, Optional[str]]:
    host = os.environ.get("POSTGRES_PGHOST") or os.environ.get("POSTGRES_HOST")
    port = int(os.environ.get("POSTGRES_PGPORT") or os.environ.get("POSTGRES_PORT") or 5432)
    user = os.environ.get("POSTGRES_PGUSER") or os.environ.get("POSTGRES_USER", "postgres")
    database = (
        os.environ.get("POSTGRES_PGDATABASE")
        or os.environ.get("POSTGRES_DATABASE", "postgres")
    )
    region = (
        os.environ.get("POSTGRES_AWS_REGION")
        or os.environ.get("AWS_REGION", "ap-south-1")
    )
    role_arn = os.environ.get("POSTGRES_AWS_ROLE_ARN")
    if not host:
        raise RuntimeError("Aurora host missing — set POSTGRES_PGHOST")
    return host, port, user, database, region, role_arn


def _rds_auth_token(
    host: str, port: int, user: str, region: str, role_arn: Optional[str]
) -> str:
    creds = get_aws_credentials(role_arn)
    if creds is None:
        client = boto3.client("rds", region_name=region)
    else:
        client = boto3.client(
            "rds",
            region_name=region,
            aws_access_key_id=creds.access_key,
            aws_secret_access_key=creds.secret_key,
            aws_session_token=creds.session_token,
        )
    return client.generate_db_auth_token(
        DBHostname=host, Port=port, DBUsername=user, Region=region
    )


async def get_pool() -> asyncpg.Pool:
    global _pool, _pool_created_at
    if _pool is not None and (time.time() - _pool_created_at) < _POOL_TTL_SECONDS:
        return _pool
    if _pool is not None:
        await _pool.close()
        _pool = None
    host, port, user, database, region, role_arn = _config()
    password = _rds_auth_token(host, port, user, region, role_arn)
    ssl_ctx = ssl.create_default_context()
    _pool = await asyncpg.create_pool(
        host=host,
        port=port,
        user=user,
        password=password,
        database=database,
        ssl=ssl_ctx,
        min_size=1,
        max_size=5,
        command_timeout=30,
    )
    _pool_created_at = time.time()
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


async def ping() -> dict:
    """Lightweight health-check: round-trip a `SELECT 1` against Aurora."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        result = await conn.fetchval("SELECT 1")
        version = await conn.fetchval("SELECT version()")
    return {"ok": result == 1, "version": version}
