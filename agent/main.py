"""
Cascade agent — Google ADK assembly.

Usage (CLI smoke test):
    source .venv/bin/activate
    python -m agent.main "Tell me about today's NVDA news and its cascade"
"""

from __future__ import annotations

import asyncio
import os
import sys

from google.adk.agents import Agent
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types as genai_types

from agent.prompts import SYSTEM_PROMPT
from agent.tools import (
    aggregate_stats,
    build_cascade,
    get_company,
    get_prices,
    optimize_self,
    search_events,
)


def _model() -> str:
    return os.environ.get("GEMINI_MODEL", "gemini-3-flash-preview")


def create_agent() -> Agent:
    """Build and return the Cascade ADK agent."""
    return Agent(
        name="cascade",
        model=_model(),
        instruction=SYSTEM_PROMPT,
        tools=[
            search_events,
            build_cascade,
            get_company,
            get_prices,
            aggregate_stats,
            optimize_self,
        ],
    )


# Module-level singleton used by FastAPI (Phase 5)
cascade_agent = create_agent()


async def run_query(query: str, verbose: bool = False) -> str:
    """
    Run a single query through the agent and return the final text response.
    Prints tool call events to stderr when verbose=True.
    """
    session_service = InMemorySessionService()
    runner = Runner(
        app_name="cascade",
        agent=cascade_agent,
        session_service=session_service,
        auto_create_session=True,
    )

    session = await session_service.create_session(
        app_name="cascade",
        user_id="cli",
        session_id="cli-session",
    )

    message = genai_types.Content(
        role="user",
        parts=[genai_types.Part(text=query)],
    )

    final_text = ""
    async for event in runner.run_async(
        user_id="cli",
        session_id=session.id,
        new_message=message,
    ):
        if verbose:
            # Show tool calls on stderr so stdout stays clean
            if hasattr(event, "content") and event.content:
                for part in event.content.parts or []:
                    if hasattr(part, "function_call") and part.function_call:
                        fc = part.function_call
                        print(f"[tool] {fc.name}({list((fc.args or {}).keys())})", file=sys.stderr)
                    if hasattr(part, "function_response") and part.function_response:
                        fr = part.function_response
                        print(f"[tool_result] {fr.name} → ok", file=sys.stderr)

        # Capture final text response
        if hasattr(event, "is_final_response") and event.is_final_response():
            if event.content and event.content.parts:
                for part in event.content.parts:
                    if hasattr(part, "text") and part.text:
                        final_text += part.text

    return final_text or "(no response)"


if __name__ == "__main__":
    from workers._common import load_dotenv_once

    load_dotenv_once()

    query = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else "Tell me about today's NVDA news and its cascade"
    print(f"Query: {query}\n", file=sys.stderr)

    result = asyncio.run(run_query(query, verbose=True))
    print(result)
