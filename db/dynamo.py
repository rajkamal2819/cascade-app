"""
DynamoDB adapter — aioboto3 client with OIDC-assumed creds.

Single-table design: one DynamoDB table (`DYNAMODB_TABLE_NAME`, default
`ripple-dynamodb`) holds three logical entity types distinguished by
`PK` prefix:

    PK                       SK                       Entity
    -----------------------  -----------------------  ---------------------------------
    EVENT#<source_type>      <ingested_at ISO>        Live event mirror (TTL'd, Streams)
    USER#<device_id>         <viewed_at ISO>          Anonymous cascade-view history
    WATCHLIST#<user_id>      META                     Per-user ticker watchlist

Authentication path (production):
    1. Vercel injects `VERCEL_OIDC_TOKEN` per request.
    2. STS `AssumeRoleWithWebIdentity` exchanges it for temp creds scoped to
       `DYNAMODB_AWS_ROLE_ARN` (the role the Marketplace integration created).
    3. aioboto3 client uses those creds.

Local dev with no OIDC token falls back to the default boto3 credential chain.
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

import aioboto3

from ._aws_creds import get_aws_credentials

EVENT_PK_PREFIX = "EVENT#"
USER_PK_PREFIX = "USER#"
WATCHLIST_PK_PREFIX = "WATCHLIST#"
WATCHLIST_META_SK = "META"


def table_name() -> str:
    return (
        os.environ.get("DYNAMODB_TABLE_NAME")
        or os.environ.get("DYNAMODB_TABLE", "ripple-dynamodb")
    )


def aws_region() -> str:
    return (
        os.environ.get("DYNAMODB_AWS_REGION")
        or os.environ.get("AWS_REGION", "ap-south-1")
    )


def event_pk(source_type: str) -> str:
    return f"{EVENT_PK_PREFIX}{source_type}"


def user_pk(device_id: str) -> str:
    return f"{USER_PK_PREFIX}{device_id}"


def watchlist_pk(user_id: str) -> str:
    return f"{WATCHLIST_PK_PREFIX}{user_id}"


def _build_session() -> aioboto3.Session:
    role_arn = os.environ.get("DYNAMODB_AWS_ROLE_ARN")
    creds = get_aws_credentials(role_arn)
    if creds is None:
        return aioboto3.Session(region_name=aws_region())
    return aioboto3.Session(
        aws_access_key_id=creds.access_key,
        aws_secret_access_key=creds.secret_key,
        aws_session_token=creds.session_token,
        region_name=aws_region(),
    )


@asynccontextmanager
async def get_table() -> AsyncIterator[Any]:
    """Yield the DynamoDB Table resource.

    Usage:
        async with get_table() as table:
            await table.put_item(Item={...})
    """
    session = _build_session()
    async with session.resource("dynamodb", region_name=aws_region()) as resource:
        yield await resource.Table(table_name())


async def ping() -> dict:
    """Lightweight health-check: DescribeTable on the configured table."""
    session = _build_session()
    async with session.client("dynamodb", region_name=aws_region()) as client:
        resp = await client.describe_table(TableName=table_name())
    t = resp["Table"]
    return {
        "ok": t.get("TableStatus") == "ACTIVE",
        "table": t["TableName"],
        "status": t.get("TableStatus"),
        "item_count": t.get("ItemCount", 0),
    }
