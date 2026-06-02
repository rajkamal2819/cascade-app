"""
Vercel Python Serverless Function entrypoint for the Cascade FastAPI app.

Vercel's Python runtime discovers `api/index.py` and serves any matched route
under `/api/*` through the ASGI handler exported here. The existing FastAPI
`app` from `api/main.py` is wrapped with `mangum` so it speaks the ASGI →
Lambda-style event interface that Vercel's runtime uses.

Rewrites in `vercel.json` send all `/api/*` traffic to this single function,
so `api/main.py`'s router stays the source of truth for the API surface.
"""

from __future__ import annotations

from mangum import Mangum

from api.main import app as fastapi_app

# Vercel's Python runtime looks for `handler` (or any ASGI/WSGI callable named
# `app`). Exporting both keeps it tolerant to runtime-version drift.
handler = Mangum(fastapi_app, lifespan="off")
app = fastapi_app
