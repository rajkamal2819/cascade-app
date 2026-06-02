"""
Reddit (r/wallstreetbets, r/stocks, r/investing) → events collection.

Polls /hot from each subreddit every 10 minutes, keeps posts with >= 100
upvotes, extracts tickers via `$TICKER` regex + companies-collection alias
lookup, and upserts each post as a social event.

Set in .env:
    REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USER_AGENT

Run:
    python -m workers.reddit
    python -m workers.reddit --once
"""

from __future__ import annotations

import asyncio
import os
import re
from datetime import datetime, timezone
from typing import Any

from workers._common import EventDraft, get_db, jlog, sync_main, upsert_events

NAME = "reddit_social"

SUBREDDITS = ["wallstreetbets", "stocks", "investing"]
MIN_SCORE = int(os.environ.get("REDDIT_MIN_SCORE", "100"))
TOP_LIMIT = int(os.environ.get("REDDIT_TOP_LIMIT", "50"))

CLIENT_ID = os.environ.get("REDDIT_CLIENT_ID", "").strip()
CLIENT_SECRET = os.environ.get("REDDIT_CLIENT_SECRET", "").strip()
USER_AGENT = os.environ.get("REDDIT_USER_AGENT", "cascade-research/0.1").strip()

TICKER_RE = re.compile(r"\$([A-Z]{1,5})\b")
WORD_RE = re.compile(r"\b([A-Z]{2,5})\b")  # bare uppercase words, validated against companies

# Cache of known ticker set, loaded once.
_known: set[str] | None = None


async def _known_tickers() -> set[str]:
    global _known
    if _known is not None:
        return _known
    db = get_db()
    _known = {doc["ticker"] async for doc in db.companies.find({}, {"ticker": 1})}
    jlog("info", "reddit.known_tickers.loaded", count=len(_known))
    return _known


async def _extract_tickers(text: str) -> list[str]:
    """Regex extraction with $TICKER preferred; bare words only if in known set."""
    known = await _known_tickers()
    found: set[str] = set(TICKER_RE.findall(text))
    # Augment with bare-word matches that look like tickers and are in our known set.
    for word in WORD_RE.findall(text):
        if word in known:
            found.add(word)
    return sorted(found)


def _impact_from_score(score: int) -> str:
    if score >= 5000:
        return "high"
    if score >= 1000:
        return "medium"
    return "low"


def _client():
    import praw

    return praw.Reddit(
        client_id=CLIENT_ID,
        client_secret=CLIENT_SECRET,
        user_agent=USER_AGENT,
        check_for_async=False,  # we're calling sync praw inside run_in_executor
    )


def _fetch_sync() -> list[dict[str, Any]]:
    """Synchronous praw call — run in executor to keep the loop free."""
    reddit = _client()
    out: list[dict[str, Any]] = []
    for sub_name in SUBREDDITS:
        sub = reddit.subreddit(sub_name)
        for post in sub.hot(limit=TOP_LIMIT):
            if post.stickied or post.score < MIN_SCORE:
                continue
            out.append(
                {
                    "id": post.id,
                    "permalink": f"https://reddit.com{post.permalink}",
                    "subreddit": sub_name,
                    "title": post.title or "",
                    "selftext": post.selftext or "",
                    "score": int(post.score),
                    "num_comments": int(post.num_comments),
                    "created_utc": float(post.created_utc),
                    "author": str(post.author) if post.author else None,
                }
            )
    return out


async def poll_once() -> None:
    if not (CLIENT_ID and CLIENT_SECRET):
        jlog("warn", "reddit.no_creds", message="REDDIT_CLIENT_ID/SECRET not set; skipping")
        return

    loop = asyncio.get_running_loop()
    posts = await loop.run_in_executor(None, _fetch_sync)

    drafts: list[EventDraft] = []
    for p in posts:
        text = f"r/{p['subreddit']} · {p['title']}\n\n{p['selftext']}".strip()
        tickers = await _extract_tickers(text)
        if not tickers:
            continue

        drafts.append(
            EventDraft(
                source=f"r/{p['subreddit']}",
                source_type="social",
                external_id=p["id"],
                text=text,
                tickers=tickers,
                published_at=datetime.fromtimestamp(p["created_utc"], tz=timezone.utc),
                impact=_impact_from_score(p["score"]),
                entities=[p["author"]] if p["author"] else None,
                url=p["permalink"],
                extra={
                    "score": p["score"],
                    "num_comments": p["num_comments"],
                    "subreddit": p["subreddit"],
                },
            )
        )

    inserted, modified = await upsert_events(drafts)
    jlog(
        "info",
        "reddit.poll.done",
        posts=len(posts),
        drafted=len(drafts),
        inserted=inserted,
        modified=modified,
    )


if __name__ == "__main__":
    sync_main(NAME, poll_once, default_interval=600.0)  # 10 min
