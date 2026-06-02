"""
Vercel Python Serverless Function entrypoint for the Cascade FastAPI app.

Minimal bootstrap surface during the Mongo → Aurora/DynamoDB port. Exposes a
`/api/health` endpoint that exercises both AWS data adapters end-to-end so the
OIDC → STS → RDS-IAM (Aurora) and OIDC → STS → DynamoDB credential paths can
be verified against the live Vercel deployment. The full `api/main.py` router
is wired back in once Mongo call sites are migrated to `db/aurora.py` /
`db/dynamo.py`.
"""

from __future__ import annotations

import os
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from mangum import Mangum

from db import aurora, dynamo

app = FastAPI(
    title="Cascade API",
    description="Real-time market cascade intelligence (H0 bootstrap surface).",
    version="0.6.0-bootstrap",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health() -> dict[str, Any]:
    aurora_state: dict[str, Any]
    try:
        aurora_state = await aurora.ping()
    except Exception as e:
        aurora_state = {"ok": False, "error": str(e)[:300]}

    dynamo_state: dict[str, Any]
    try:
        dynamo_state = await dynamo.ping()
    except Exception as e:
        dynamo_state = {"ok": False, "error": str(e)[:300]}

    return {
        "ok": aurora_state.get("ok") and dynamo_state.get("ok"),
        "aurora": aurora_state,
        "dynamo": dynamo_state,
        "region": os.environ.get("AWS_REGION")
        or os.environ.get("POSTGRES_AWS_REGION")
        or "unset",
        "oidc": "present" if os.environ.get("VERCEL_OIDC_TOKEN") else "missing",
    }


handler = Mangum(app, lifespan="off")
