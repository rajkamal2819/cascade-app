"""
Shared FastAPI dependencies — singleton Mongo client and lifespan setup.

The M0 free tier has a 100-connection limit, so we keep a single
AsyncIOMotorClient per process with a small pool.
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, Request
from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase

DB_NAME = os.environ.get("MONGODB_DB", "cascade")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """FastAPI startup/shutdown — open and close the Motor client."""
    uri = os.environ.get("MONGODB_URI")
    if not uri:
        raise RuntimeError("MONGODB_URI not set")

    client = AsyncIOMotorClient(
        uri,
        maxPoolSize=10,
        serverSelectionTimeoutMS=5000,
        appname="cascade-api",
    )
    # Force a server roundtrip so misconfig surfaces at boot, not first request.
    await client.admin.command("ping")
    app.state.mongo = client
    app.state.db = client[DB_NAME]
    try:
        yield
    finally:
        client.close()


def get_db(request: Request) -> AsyncIOMotorDatabase:
    """FastAPI dependency that returns the shared Motor database."""
    return request.app.state.db
