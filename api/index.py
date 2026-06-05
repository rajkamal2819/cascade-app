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

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from mangum import Mangum

from db import aurora, dynamo, _aws_creds
from api.admin import router as admin_router
from api.feed import router as feed_router
from api.graph import router as graph_router

app = FastAPI(
    title="Cascade API",
    description="Real-time market cascade intelligence on Vercel + AWS Databases.",
    version="0.8.1-mvp",
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


@app.middleware("http")
async def capture_oidc_token(request: Request, call_next):
    """Stash the Vercel OIDC token into a contextvar so adapter code can
    exchange it for AWS creds. Vercel injects it as the `x-vercel-oidc-token`
    header on every Function invocation."""
    token = request.headers.get("x-vercel-oidc-token")
    if token:
        reset_token = _aws_creds.oidc_token.set(token)
        try:
            return await call_next(request)
        finally:
            _aws_creds.oidc_token.reset(reset_token)
    return await call_next(request)


@app.get("/api/debug/env")
async def debug_env(request: Request) -> dict[str, Any]:
    """Diagnostic — Vercel/AWS env presence + OIDC header presence (never values)."""
    keys_to_check = [
        "VERCEL_OIDC_TOKEN",
        "POSTGRES_AWS_ROLE_ARN",
        "POSTGRES_PGHOST",
        "DYNAMODB_AWS_ROLE_ARN",
        "DYNAMODB_TABLE_NAME",
        "AWS_REGION",
        "CRON_SECRET",
    ]
    present = {
        k: f"set ({len(v)} chars)" if (v := os.environ.get(k)) else "MISSING"
        for k in keys_to_check
    }
    header_token = request.headers.get("x-vercel-oidc-token")
    cv_token = _aws_creds.oidc_token.get()
    return {
        "env": present,
        "oidc_header_present": bool(header_token),
        "oidc_header_length": len(header_token) if header_token else 0,
        "oidc_contextvar_set": bool(cv_token),
        "all_headers": sorted(request.headers.keys()),
    }


@app.get("/api/health")
async def health(request: Request) -> dict[str, Any]:
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
        "oidc": "present" if request.headers.get("x-vercel-oidc-token") else "missing",
    }


app.include_router(admin_router)
app.include_router(feed_router)
app.include_router(graph_router)


handler = Mangum(app, lifespan="off")
