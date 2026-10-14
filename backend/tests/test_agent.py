import pytest
from pydantic_ai.models.test import TestModel

from app.agents.agent import NO_STATE, ChatDeps, agent
from tests.test_world import make_state

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return 'asyncio'


QUERY_TOOLS = ['check_inventory', 'look_around', 'nearby_entities', 'where_are_we']


async def test_query_tools_read_state():
    deps = ChatDeps(username='Steve', state=make_state())
    with agent.override(model=TestModel(call_tools=QUERY_TOOLS)):
        result = await agent.run('Steve: what do you see?', deps=deps)
    returns = [p.content for m in result.new_messages() for p in m.parts if p.part_kind == 'tool-return']
    assert 'Inventory is empty.' in returns
    assert any('You are at (10, 64, -3)' in r for r in returns)
    assert deps.actions == []


async def test_no_state_fallback():
    deps = ChatDeps(username='Steve')
    with agent.override(model=TestModel(call_tools=QUERY_TOOLS)):
        result = await agent.run('Steve: hi', deps=deps)
    returns = [p.content for m in result.new_messages() for p in m.parts if p.part_kind == 'tool-return']
    assert returns == [NO_STATE] * len(QUERY_TOOLS)


async def test_status_leads_the_message_and_stays_out_of_the_instructions():
    """The instructions must not change from message to message, or prompt caching can't reuse them."""
    from fastapi.testclient import TestClient
    from pydantic_ai.messages import ModelResponse, TextPart
    from pydantic_ai.models.function import FunctionModel

    from app.main import app

    seen = []

    def respond(messages, info):
        seen.append((messages[-1].parts[0].content, messages[-1].instructions))
        return ModelResponse(parts=[TextPart('ok')])

    state = make_state().model_dump(mode='json')
    client = TestClient(app)
    with agent.override(model=FunctionModel(respond)):
        client.post('/chat', json={'username': 'Steve', 'message': 'hello there', 'state': state})
        client.post('/chat', json={'username': 'Steve', 'message': 'hello again', 'state': {**state, 'health': 3}})
    (first, first_instructions), (second, second_instructions) = seen
    assert first.startswith('[Status] Your status: health 17.5/20') and first.endswith('\nSteve: hello there')
    assert second.startswith('[Status] Your status: health 3/20')
    assert 'health' not in (first_instructions or '')
    assert first_instructions == second_instructions


async def test_tool_definitions_stay_under_their_size_limit():
    """Every tool is sent on every request, so each one adds tokens to every message. This fails when the
    definitions grow past the limit; raise the limit on purpose, after measuring with
    `uv run python backend/scripts/count-prompt-tokens.py`, not to make the test pass.

    Measured 2026-10-14 with count_tokens on Haiku 5.5: 7,287 tokens for 16,878 characters of JSON (2.32
    characters per token). The limit is about 8,000 tokens, so a handful of tools or a long new description
    fits, and a large one is a decision.
    """
    import json

    from pydantic_ai.messages import ModelResponse, TextPart
    from pydantic_ai.models.function import FunctionModel

    from app.agents.agent import OUTPUT_TYPES

    seen = []

    def stub(messages, info):
        seen.extend(
            {'name': t.name, 'description': t.description or '', 'input_schema': t.parameters_json_schema}
            for t in [*info.function_tools, *info.output_tools]
        )
        return ModelResponse(parts=[TextPart('ok')])

    with agent.override(model=FunctionModel(stub)):
        await agent.run('hi', deps=ChatDeps(username='Steve'), output_type=OUTPUT_TYPES)
    size = len(json.dumps(seen, separators=(',', ':')))
    assert len(seen) >= 40, 'the action tools must be sent too'
    assert size <= 18_600, f'tool definitions are {size} characters (about {size / 2.32:.0f} tokens); the limit is 18,600 (about 8,000)'
