"""
DynamoDB adapter — aioboto3 client + single-table helpers.

Single-table design: one DynamoDB table (env `DYNAMODB_TABLE`, default
`ripple-dynamodb`) holds three logical entity types distinguished by
`PK` prefix:

    PK                       SK                       Entity
    -----------------------  -----------------------  ----------------------------------
    EVENT#<source_type>      <ingested_at ISO>        Live event mirror (TTL'd, Streams-watched)
    USER#<device_id>         <viewed_at ISO>          Anonymous cascade-view history
    WATCHLIST#<user_id>      META                     Per-user ticker watchlist
    WATCHLIST#<user_id>      TICKER#<symbol>          Individual watchlist entry (future)

Helpers below enforce the prefix convention so call sites in `agent/`,
`api/`, and `workers/` don't sprinkle ad-hoc string concatenation.

This file is a STUB for the Day 3–5 bootstrap. Real implementation lands in
Days 10–14 (`/Users/rajkamal/.claude/plans/now-i-want-you-binary-raven.md` §13.8):

    - get_table()                                  ← shared aioboto3 resource
    - put_event_mirror(event)                      ← replaces the events-collection write
    - get_recent_events(source_type, limit)
    - put_user_view(device_id, event_id, ...)      ← replaces user_memory inserts
    - get_user_history(device_id, limit)
    - delete_user_history(device_id)
    - upsert_watchlist(user_id, tickers)
    - get_watchlist(user_id)
"""

from __future__ import annotations

import os
from typing import Any

# Single-table prefixes — keep these as module constants so call sites
# never inline string literals.
EVENT_PK_PREFIX = "EVENT#"
USER_PK_PREFIX = "USER#"
WATCHLIST_PK_PREFIX = "WATCHLIST#"

WATCHLIST_META_SK = "META"


def table_name() -> str:
    """Resolve the DynamoDB table name from env. Defaults to `ripple-dynamodb`."""
    return os.environ.get("DYNAMODB_TABLE", "ripple-dynamodb")


def aws_region() -> str:
    return os.environ.get("AWS_REGION", "ap-south-1")


def event_pk(source_type: str) -> str:
    """Compose the PK for an event-stream item."""
    return f"{EVENT_PK_PREFIX}{source_type}"


def user_pk(device_id: str) -> str:
    return f"{USER_PK_PREFIX}{device_id}"


def watchlist_pk(user_id: str) -> str:
    return f"{WATCHLIST_PK_PREFIX}{user_id}"


async def get_table() -> Any:
    """Lazily initialise and return the shared aioboto3 Table resource.

    NOT YET IMPLEMENTED. Tracked for Days 10–14.
    """
    raise NotImplementedError(
        "db.dynamo.get_table — implementation pending (plan §13.8 Days 10–14)"
    )
