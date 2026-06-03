"""
AWS credential acquisition via Vercel OIDC (per-request).

Vercel injects the OIDC token as the `x-vercel-oidc-token` HTTP header on
every request to a Vercel Function — NOT as an env var. A FastAPI middleware
in `api/index.py` reads that header and stashes it in the `oidc_token`
contextvar below. Adapter calls then exchange it via STS
`AssumeRoleWithWebIdentity` for short-lived AWS creds scoped to the
per-database role the Marketplace integration created.

Caching: AWS creds are cached per role ARN, keyed by the OIDC subject so
different requests/environments don't share creds. Refreshed when within
5 minutes of expiry.

Local dev (no token, no role ARN): returns None — callers fall back to the
default boto3 credential chain.
"""

from __future__ import annotations

import contextvars
import time
from dataclasses import dataclass
from typing import Optional

import boto3

# Per-request OIDC token, set by the FastAPI middleware.
oidc_token: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "oidc_token", default=None
)

_SESSION_NAME = "vercel-cascade"
_REFRESH_BUFFER_SECONDS = 300


@dataclass
class AwsCreds:
    access_key: str
    secret_key: str
    session_token: str
    expires_at: float


# Per role-ARN cache. Re-used across requests until expiry.
_cache: dict[str, AwsCreds] = {}


def _assume_role(role_arn: str, token: str) -> AwsCreds:
    sts = boto3.client("sts", region_name="us-east-1")
    resp = sts.assume_role_with_web_identity(
        RoleArn=role_arn,
        RoleSessionName=_SESSION_NAME,
        WebIdentityToken=token,
        DurationSeconds=3600,
    )
    c = resp["Credentials"]
    return AwsCreds(
        access_key=c["AccessKeyId"],
        secret_key=c["SecretAccessKey"],
        session_token=c["SessionToken"],
        expires_at=c["Expiration"].timestamp(),
    )


def get_aws_credentials(role_arn: Optional[str]) -> Optional[AwsCreds]:
    """Resolve AWS credentials for `role_arn` via the per-request OIDC token.

    Returns None when no token is available (local dev) — callers should
    fall back to the default boto3 credential chain.
    """
    token = oidc_token.get()
    if not token or not role_arn:
        return None
    cached = _cache.get(role_arn)
    now = time.time()
    if cached and cached.expires_at - now > _REFRESH_BUFFER_SECONDS:
        return cached
    fresh = _assume_role(role_arn, token)
    _cache[role_arn] = fresh
    return fresh
