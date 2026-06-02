"""
Vercel Python Serverless Function entrypoint for the Cascade FastAPI app.

Routes mounted:
    /api/health              — dual-DB connectivity probe
    /api/admin/*             — schema bootstrap, seed (CRON_SECRET gated)
    /api/companies, /api/cascade/walk, /api/geo/nearby — public read endpoints
"""

from __future__ import annotations

import os
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from mangum import Mangum

from db import aurora, dynamo
from api.admin import router as admin_router
from api.graph import router as graph_router

app = FastAPI(
    title="Cascade API",
    description="Real-time market cascade intelligence on Vercel + AWS Databases.",
    version="0.7.0-mvp",
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


@app.get("/api/debug/env")
async def debug_env() -> dict[str, Any]:
    """Diagnostic — lists Vercel/AWS env var presence (NEVER values).
    Used to verify whether VERCEL_OIDC_TOKEN is being injected."""
    keys_to_check = [
        "VERCEL_OIDC_TOKEN",
        "VERCEL_ENV",
        "VERCEL_URL",
        "VERCEL_REGION",
        "VERCEL_DEPLOYMENT_ID",
        "POSTGRES_AWS_ROLE_ARN",
        "POSTGRES_PGHOST",
        "DYNAMODB_AWS_ROLE_ARN",
        "DYNAMODB_TABLE_NAME",
        "AWS_REGION",
        "AWS_LAMBDA_FUNCTION_NAME",
        "CRON_SECRET",
    ]
    present = {}
    for k in keys_to_check:
        v = os.environ.get(k)
        if v:
            present[k] = f"set ({len(v)} chars)"
        else:
            present[k] = "MISSING"
    vercel_keys = sorted([k for k in os.environ if k.startswith("VERCEL_")])
    aws_keys = sorted([k for k in os.environ if k.startswith("AWS_") or k.startswith("POSTGRES_") or k.startswith("DYNAMODB_")])
    return {
        "checked": present,
        "all_vercel_keys": vercel_keys,
        "all_aws_postgres_dynamo_keys": aws_keys,
    }


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


app.include_router(admin_router)
app.include_router(graph_router)


handler = Mangum(app, lifespan="off")
