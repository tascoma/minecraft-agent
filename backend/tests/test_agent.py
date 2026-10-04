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


async def test_status_in_instructions_and_no_state_fallback():
    deps = ChatDeps(username='Steve')
    with agent.override(model=TestModel(call_tools=QUERY_TOOLS)):
        result = await agent.run('Steve: hi', deps=deps)
    returns = [p.content for m in result.new_messages() for p in m.parts if p.part_kind == 'tool-return']
    assert returns == [NO_STATE] * len(QUERY_TOOLS)

    with agent.override(model=TestModel(call_tools=[])):
        result = await agent.run('Steve: hi', deps=ChatDeps(username='Steve', state=make_state()))
    assert 'health 17.5/20' in result.all_messages()[0].instructions
