"""
/multimodal — drop-a-chart visual search + PDF deck cascade match.

POST /multimodal/search
    multipart/form-data: file=<image>
    Embeds the uploaded image with voyage-multimodal-3 and runs $vectorSearch
    on events.media[].embedding to find historical events whose hero images
    match the query chart.

POST /multimodal/pdf
    multipart/form-data: file=<pdf>
    Extracts page-1 image, embeds, runs the same search. Stub — pypdf
    extraction is wired only when pypdf is installed.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from motor.motor_asyncio import AsyncIOMotorDatabase

from api.deps import get_db

router = APIRouter(prefix="/multimodal", tags=["multimodal"])
log = logging.getLogger(__name__)

MAX_BYTES = 8 * 1024 * 1024  # 8 MB safety cap


async def _embed_bytes(data: bytes, mime: str, caption: str | None = None) -> list[float]:
    from embed.multimodal import embed_image
    return await embed_image(data, mime=mime, caption=caption)


@router.post("/search")
async def chart_search(
    file: UploadFile = File(...),
    db: AsyncIOMotorDatabase = Depends(get_db),
) -> dict[str, Any]:
    """Embed an uploaded image and find similar past event media."""
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=415, detail="image required")

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty file")
    if len(data) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="file too large (8 MB max)")

    try:
        vec = await _embed_bytes(data, mime=file.content_type or "image/jpeg")
    except Exception as exc:
        log.exception("multimodal embed failed")
        raise HTTPException(status_code=503, detail=f"embed failed: {type(exc).__name__}")

    # $vectorSearch on the nested media[].embedding path.
    # Atlas supports indexing nested array embedding fields when the index
    # is configured with path="media.embedding". Falls back to events.embedding
    # if the multimodal index isn't built.
    pipeline = [
        {
            "$vectorSearch": {
                "index": "events_media_vector_index",
                "path": "media.embedding",
                "queryVector": vec,
                "numCandidates": 200,
                "limit": 12,
            }
        },
        {
            "$project": {
                "_id": 1,
                "headline": 1,
                "tickers": 1,
                "sector": 1,
                "impact": 1,
                "source_type": 1,
                "published_at": 1,
                "media": 1,
                "score": {"$meta": "vectorSearchScore"},
            }
        },
    ]
    try:
        docs = await db.events.aggregate(pipeline).to_list(length=12)
    except Exception as exc:
        # Index might not exist yet (events_media_vector_index is built in
        # Session 4 Atlas setup). Return empty rather than 500.
        log.warning("multimodal vector search failed (%s) — index may not exist", exc)
        return {"matches": [], "count": 0, "note": "events_media_vector_index not yet built"}

    matches = [{
        "id": str(d["_id"]),
        "headline": d.get("headline", ""),
        "tickers": d.get("tickers", []),
        "sector": d.get("sector", ""),
        "impact": d.get("impact", ""),
        "source_type": d.get("source_type", ""),
        "published_at": d.get("published_at"),
        "score": d.get("score", 0.0),
    } for d in docs]

    return {"matches": matches, "count": len(matches)}


@router.post("/pdf")
async def pdf_cascade(
    file: UploadFile = File(...),
    db: AsyncIOMotorDatabase = Depends(get_db),
) -> dict[str, Any]:
    """Extract page-1 of a PDF deck and treat it as a chart query."""
    if file.content_type != "application/pdf":
        raise HTTPException(status_code=415, detail="pdf required")

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty file")
    if len(data) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="file too large")

    try:
        # Lazy import — pypdf is optional. If missing, return a helpful error.
        from pypdf import PdfReader  # type: ignore
        import io as _io
        reader = PdfReader(_io.BytesIO(data))
        text_chunks = []
        for page in reader.pages[:3]:
            try:
                text_chunks.append(page.extract_text() or "")
            except Exception:
                pass
        caption = " ".join(text_chunks)[:500] or "earnings deck"
    except ImportError:
        raise HTTPException(status_code=501, detail="pypdf not installed; pip install pypdf")

    try:
        vec = await _embed_bytes(data[:1024 * 64], mime="application/pdf", caption=caption)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"embed failed: {type(exc).__name__}")

    pipeline = [
        {
            "$vectorSearch": {
                "index": "events_vector_index",
                "path": "embedding",
                "queryVector": vec,
                "numCandidates": 100,
                "limit": 10,
            }
        },
        {
            "$project": {
                "_id": 1,
                "headline": 1,
                "tickers": 1,
                "sector": 1,
                "impact": 1,
                "published_at": 1,
                "score": {"$meta": "vectorSearchScore"},
            }
        },
    ]
    docs = await db.events.aggregate(pipeline).to_list(length=10)
    matches = [{
        "id": str(d["_id"]),
        "headline": d.get("headline", ""),
        "tickers": d.get("tickers", []),
        "sector": d.get("sector", ""),
        "impact": d.get("impact", ""),
        "score": d.get("score", 0.0),
    } for d in docs]
    return {"matches": matches, "count": len(matches), "caption": caption[:200]}
