"""
Pydantic v2 schemas for the Cascade public API.

Strict mode, ISO datetimes, integer counts. Used both for request validation
and OpenAPI documentation.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

Impact = Literal["critical", "high", "medium", "low"]


class EventOut(BaseModel):
    id: str
    headline: str = ""
    text: str = ""
    tickers: list[str] = Field(default_factory=list)
    entities: list[str] = Field(default_factory=list)
    sector: str = ""
    impact: Impact | str = ""
    source_type: str = ""
    source_url: str = ""
    published_at: datetime | None = None
    ingested_at: datetime | None = None
    has_cascade: bool = False
    replay: str = ""


class EventList(BaseModel):
    events: list[EventOut]
    count: int


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=500)
    sector: str = ""
    impact: str = ""
    days_back: int = Field(default=7, ge=1, le=90)
    limit: int = Field(default=10, ge=1, le=50)


class SearchHit(BaseModel):
    id: str
    headline: str = ""
    tickers: list[str] = Field(default_factory=list)
    sector: str = ""
    impact: str = ""
    source_type: str = ""
    published_at: str = ""
    rerank_score: float = 0.0


class SearchResponse(BaseModel):
    query: str
    events: list[SearchHit]
    count: int


class CascadeRequest(BaseModel):
    event_id: str = Field(min_length=10, max_length=64)
    max_hops: int = Field(default=3, ge=1, le=3)
    top_k: int = Field(default=15, ge=1, le=50)
    device_id: str = Field(default="", max_length=64)


class CascadeNode(BaseModel):
    ticker: str
    company: str = ""
    sector: str = ""
    level: str
    hop: int
    relationship_type: str
    cascade_score: float
    why: str
    event_id: str = ""  # most-recent event involving this ticker — drives drill-in
    direction: int = 0  # -1 negative, 0 neutral/unknown, +1 positive — geo-cascade only


class GeoRegion(BaseModel):
    name: str
    iso: str | None = None
    role: str = "other"
    lat: float | None = None  # Gemini-inferred centroid for globe placement
    lon: float | None = None


class GeoSectorExposure(BaseModel):
    name: str
    exposure: str = "other"
    confidence: float = 0.5


class GeoCascadeMeta(BaseModel):
    event_type: str = "other"
    regions: list[GeoRegion] = Field(default_factory=list)
    sectors: list[GeoSectorExposure] = Field(default_factory=list)
    transmission_mechanism: str = ""
    time_horizon: str = ""
    historical_analog: str = ""
    model: str = ""


class CascadeEdge(BaseModel):
    from_: str = Field(alias="from")
    to: str
    type: str
    weight: float
    hop: int

    class Config:
        populate_by_name = True


class CascadeRoot(BaseModel):
    id: str
    headline: str = ""
    tickers: list[str] = Field(default_factory=list)
    impact: str = ""
    sector: str = ""
    published_at: str = ""
    source_type: str = ""


class CascadeResponse(BaseModel):
    root: CascadeRoot
    nodes: list[CascadeNode]
    edges: list[CascadeEdge]
    hop_counts: dict[str, int] = Field(default_factory=dict)
    message: str = ""
    fallback: str = ""
    narrative: str = ""  # cached Gemini summary (empty until synth completes)
    severity: str = ""   # LOW|MEDIUM|HIGH|CRITICAL from synthesis
    geo_cascade: GeoCascadeMeta | None = None  # Gemini 2.5 Pro impact hypothesis


class StatsResponse(BaseModel):
    impact_counts: dict[str, int]
    sector_counts: dict[str, int]
    top_tickers: list[dict[str, Any]]
    total_events: int
    cascade_count: int
    hours_back: int


class WatchlistItem(BaseModel):
    user_id: str = Field(min_length=1, max_length=128)
    tickers: list[str] = Field(default_factory=list)


class HealthResponse(BaseModel):
    ok: bool
    mongo: str
    voyage: str
    gemini_model: str
    events_24h: int
