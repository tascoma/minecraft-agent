#!/usr/bin/env python3
"""Measure what each part of the agent's prompt costs, with Anthropic's free count_tokens endpoint.

    uv run python backend/scripts/count-prompt-tokens.py

Runs the agent once against a stub model to capture the tool definitions and instructions it would
send, then counts them separately: the tools alone, the instructions with no bot state, and the
status line a typical state adds. Needs ANTHROPIC_API_KEY (from .env). Fills in the table in
docs/plans/optimization-plan.md.
"""
import asyncio
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(BACKEND), str(BACKEND / 'tests')]

from anthropic import Anthropic  # noqa: E402
from pydantic_ai.messages import ModelResponse, TextPart  # noqa: E402
from pydantic_ai.models.function import AgentInfo, FunctionModel  # noqa: E402

from app.agents.agent import ChatDeps, agent  # noqa: E402
from app.core.config import get_settings  # noqa: E402
from test_world import make_state  # noqa: E402


async def capture(deps: ChatDeps) -> tuple[list[dict], str]:
    """The tool definitions (Anthropic format) and the instructions of one run."""
    seen: dict = {}

    def stub(messages, info: AgentInfo) -> ModelResponse:
        seen['tools'] = [
            {'name': t.name, 'description': t.description or '', 'input_schema': t.parameters_json_schema}
            for t in info.function_tools
        ]
        seen['instructions'] = messages[0].instructions or ''
        return ModelResponse(parts=[TextPart(content='ok')])

    with agent.override(model=FunctionModel(stub)):
        await agent.run('Steve: hi', deps=deps)
    return seen['tools'], seen['instructions']


def main() -> None:
    settings = get_settings()
    client = Anthropic(api_key=settings.anthropic_api_key.get_secret_value())
    model = settings.model_name

    def count(*, tools=None, system: str | None = None) -> int:
        kwargs = {'tools': tools} if tools else {}
        if system:
            kwargs['system'] = system
        return client.messages.count_tokens(model=model, messages=[{'role': 'user', 'content': 'hi'}], **kwargs).input_tokens

    tools, bare = asyncio.run(capture(ChatDeps(username='Steve')))
    tools_s, with_state = asyncio.run(capture(ChatDeps(username='Steve', state=make_state())))
    baseline = count()
    rows = [
        (f'Tool definitions ({len(tools)} tools)', count(tools=tools) - baseline),
        ('Instructions, no bot state', count(system=bare) - baseline),
        ('Instructions with a typical state (adds status, places, etc.)', count(system=with_state) - baseline),
    ]
    print(f'Model: {model}\n')
    for name, tokens in rows:
        print(f'{tokens:>7,}  {name}')
    print(f'{rows[2][1] - rows[1][1]:>7,}  of that is the state-dependent part')


if __name__ == '__main__':
    main()
