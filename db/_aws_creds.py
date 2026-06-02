"""
AWS credential acquisition from Vercel's Marketplace integration.

The Vercel Marketplace AWS Databases integration injects credentials via a
container metadata service rather than long-lived AWS keys or OIDC tokens:

    AWS_LAMBDA_METADATA_API    — fully-qualified URL returning AWS creds JSON
    AWS_LAMBDA_METADATA_TOKEN  — bearer token sent in the Authorization header

We fetch from this endpoint directly and cache the result until just before
its Expiration. Boto3's built-in ContainerProvider can't be used here because
it enforces a hardcoded loopback-address allowlist that doesn't match
Vercel's URL.

Local dev (no AWS_LAMBDA_METADATA_API): returns None so callers fall back to
the default boto3 credential chain (AWS_PROFILE, ~/.aws/credentials, etc.).
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

import httpx

_REFRESH_BUFFER_SECONDS = 300


@dataclass
class AwsCreds:
    access_key: str
    secret_key: str
    session_token: str
    expires_at: float


_cached: Optional[AwsCreds] = None


def _parse_expiration(value: str) -> float:
    """Parse the Expiration field. Accepts ISO 8601 with or without trailing Z."""
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    return datetime.fromisoformat(value).timestamp()


def _fetch_from_vercel() -> AwsCreds:
    url = os.environ["AWS_LAMBDA_METADATA_API"]
    token = os.environ.get("AWS_LAMBDA_METADATA_TOKEN", "")
    headers = {"Authorization": token} if token else {}
    with httpx.Client(timeout=5.0) as client:
        resp = client.get(url, headers=headers)
        resp.raise_for_status()
        data = resp.json()
    return AwsCreds(
        access_key=data["AccessKeyId"],
        secret_key=data["SecretAccessKey"],
        session_token=data.get("Token", ""),
        expires_at=_parse_expiration(data["Expiration"]),
    )


def get_aws_credentials(_role_arn: Optional[str] = None) -> Optional[AwsCreds]:
    """Resolve AWS credentials from the Vercel metadata service.

    The role_arn argument is ignored (kept for backwards compatibility with the
    earlier OIDC-based implementation). Vercel's metadata service already
    returns credentials scoped to the role the Marketplace integration created.

    Returns None when AWS_LAMBDA_METADATA_API is not present (local dev) —
    the caller should fall back to the default boto3 chain in that case.
    """
    global _cached
    if "AWS_LAMBDA_METADATA_API" not in os.environ:
        return None
    now = time.time()
    if _cached and _cached.expires_at - now > _REFRESH_BUFFER_SECONDS:
        return _cached
    _cached = _fetch_from_vercel()
    return _cached
