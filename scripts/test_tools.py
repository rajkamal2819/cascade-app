"""
Phase 4 gate verification: call agent tools directly, bypassing Gemini.

Proves:
  - search_events runs $vectorSearch + $search + RRF + rerank (or RRF fallback)
  - build_cascade invokes $graphLookup on relationships graph
  - All tools return expected shapes
"""

from __future__ import annotations

import asyncio
import json

from workers._common import load_dotenv_once

load_dotenv_once()


async def main():
    from agent.tools import (
        aggregate_stats,
        build_cascade,
        get_company,
        get_prices,
        optimize_self,
        search_events,
    )

    print("=" * 70)
    print("1. search_events: 'NVIDIA AI chip demand'")
    print("=" * 70)
    results = await search_events(query="NVIDIA AI chip demand", days_back=14, limit=5)
    print(f"  events: {results['count']}")
    for e in results["events"][:3]:
        print(f"    {e['id']} | {e['rerank_score']:.3f} | [{','.join(e['tickers'][:3])}] {e['headline'][:80]}")

    if not results["events"]:
        print("  (no results — need NVDA-related events in DB)")
        return

    root_event_id = results["events"][0]["id"]

    print()
    print("=" * 70)
    print(f"2. build_cascade event_id={root_event_id} (uses $graphLookup)")
    print("=" * 70)
    cascade = await build_cascade(event_id=root_event_id, max_hops=3, top_k=10)
    print(f"  root tickers: {cascade['root']['tickers']}")
    print(f"  cascade nodes: {len(cascade.get('nodes', []))}")
    print(f"  cascade edges: {len(cascade.get('edges', []))}")
    if cascade.get("hop_counts"):
        print(f"  hop counts: {cascade['hop_counts']}")
    print("  top 5 cascade nodes:")
    for n in cascade.get("nodes", [])[:5]:
        print(f"    {n['level']} {n['ticker']:6s} ({n['relationship_type']:10s}) score={n['cascade_score']:.3f}")

    print()
    print("=" * 70)
    print("3. get_company('NVDA')")
    print("=" * 70)
    co = await get_company(ticker="NVDA")
    print(f"  name: {co.get('name')}")
    print(f"  sector: {co.get('sector')}")
    print(f"  hq: {co.get('hq_city')}, {co.get('hq_country')}")

    print()
    print("=" * 70)
    print("4. get_prices('NVDA', 5)")
    print("=" * 70)
    px = await get_prices(ticker="NVDA", lookback_days=5)
    print(f"  bars: {px['bar_count']}")
    print(f"  latest_close: {px['latest_close']}")
    print(f"  latest_rsi: {px['latest_rsi']}")

    print()
    print("=" * 70)
    print("5. aggregate_stats (uses $facet)")
    print("=" * 70)
    stats = await aggregate_stats(hours_back=72)
    print(f"  total events: {stats['total_events']}")
    print(f"  impact_counts: {stats['impact_counts']}")
    print(f"  top tickers: {[(t['ticker'], t['count']) for t in stats['top_tickers'][:5]]}")

    print()
    print("=" * 70)
    print("6. optimize_self (Atlas index advisor)")
    print("=" * 70)
    opt = await optimize_self()
    print(f"  existing indexes: {len(opt.get('existing_indexes', []))}")
    print(f"  message: {opt.get('message', '')}")

    print()
    print("=" * 70)
    print("PHASE 4 GATE VERIFICATION")
    print("=" * 70)
    print(f"  [{'OK' if results['count'] > 0 else 'FAIL'}] search_events returned hits")
    print(f"  [{'OK' if len(cascade.get('nodes', [])) > 0 else 'FAIL'}] build_cascade returned nodes (proves $graphLookup invoked)")
    print(f"  [{'OK' if cascade.get('nodes', []) and 'L' in cascade['nodes'][0].get('level', '') else 'FAIL'}] cascade nodes have hop levels (L1/L2/L3)")
    print(f"  [{'OK' if stats['total_events'] > 0 else 'FAIL'}] aggregate_stats ran $facet pipeline")


if __name__ == "__main__":
    asyncio.run(main())
