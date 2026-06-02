"""
AWS credential acquisition via Vercel OIDC.

In production Vercel Functions: `VERCEL_OIDC_TOKEN` is injected per-request. We
exchange it via STS `AssumeRoleWithWebIdentity` for short-lived AWS creds
scoped to the per-database role the Vercel Marketplace integration created
(`POSTGRES_AWS_ROLE_ARN` / `DYNAMODB_AWS_ROLE_ARN`). No long-lived AWS keys are
ever stored — this is the most-secure path called out in the H0 hackathon FAQ.

Local dev: when `VERCEL_OIDC_TOKEN` is missing, callers fall back to the
default boto3 credential chain (AWS_PROFILE, ~/.aws/credentials, etc.).
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from typing import Optional

import boto3

_SESSION_NAME = "vercel-cascade"
_REFRESH_BUFFER_SECONDS = 300


@dataclass
class AwsCreds:
    access_key: str
    secret_key: str
    session_token: str
    expires_at: float


_cache: dict[str, AwsCreds] = {}


def _assume_role_with_oidc(role_arn: str, oidc_token: str) -> AwsCreds:
    sts = boto3.client("sts")
    resp = sts.assume_role_with_web_identity(
        RoleArn=role_arn,
        RoleSessionName=_SESSION_NAME,
        WebIdentityToken=oidc_token,
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
    """Resolve AWS credentials for `role_arn` via Vercel OIDC.

    Returns None when no OIDC token is present (caller falls back to the
    default boto3 credential chain — appropriate for local dev).
    """
    oidc = os.environ.get("VERCEL_OIDC_TOKEN")
    if not oidc or not role_arn:
        return None
    cached = _cache.get(role_arn)
    now = time.time()
    if cached and cached.expires_at - now > _REFRESH_BUFFER_SECONDS:
        return cached
    fresh = _assume_role_with_oidc(role_arn, oidc)
    _cache[role_arn] = fresh
    return fresh
