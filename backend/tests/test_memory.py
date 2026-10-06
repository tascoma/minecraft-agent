from fastapi.testclient import TestClient
from pydantic_ai.messages import (
    ModelRequest,
    ModelResponse,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.models.function import FunctionModel

from app.agents.agent import agent
from app.main import app
from app.services.memory import IDLE_SECONDS, MAX_EXCHANGES, MAX_TOOL_RESULT_CHARS, ConversationMemory


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def exchange(prompt: str, reply: str) -> list:
    return [ModelRequest(parts=[UserPromptPart(content=prompt)]), ModelResponse(parts=[TextPart(content=reply)])]


def texts(messages):
    return [p.content for m in messages for p in m.parts if isinstance(p, (UserPromptPart, TextPart))]


def test_remembers_recent_exchanges_per_player():
    m = ConversationMemory(clock=FakeClock())
    m.remember('Steve', exchange('Steve: find coal', 'Coal is below us. Get it?'))
    m.remember('Alex', exchange('Alex: hi', 'Hello!'))
    assert texts(m.history('Steve')) == ['Steve: find coal', 'Coal is below us. Get it?']


def test_keeps_only_the_last_exchanges():
    m = ConversationMemory(clock=FakeClock())
    for i in range(MAX_EXCHANGES + 3):
        m.remember('Steve', exchange(f'Steve: {i}', f'reply {i}'))
    history = texts(m.history('Steve'))
    assert len(history) == MAX_EXCHANGES * 2
    assert history[0] == 'Steve: 3'


def test_forgets_after_being_idle():
    clock = FakeClock()
    m = ConversationMemory(clock=clock)
    m.remember('Steve', exchange('Steve: find coal', 'Get it?'))
    clock.now += IDLE_SECONDS + 1
    assert m.history('Steve') == []


def test_keeps_tool_calls_but_trims_long_results():
    """Without the tool calls, the model learns that saying "on my way" is enough and stops calling tools."""
    m = ConversationMemory(clock=FakeClock())
    m.remember('Steve', [
        ModelRequest(parts=[UserPromptPart(content='Steve: get 3 logs')], instructions='Your status: ...'),
        ModelResponse(parts=[ToolCallPart('collect', {'item': 'log', 'count': 3}, tool_call_id='1')]),
        ModelRequest(parts=[ToolReturnPart('collect', 'x' * 1000, tool_call_id='1')]),
        ModelResponse(parts=[TextPart(content='On my way!')]),
    ])
    history = m.history('Steve')
    assert any(isinstance(p, ToolCallPart) for msg in history for p in msg.parts)
    returned = next(p for msg in history for p in msg.parts if isinstance(p, ToolReturnPart))
    assert len(returned.content) == MAX_TOOL_RESULT_CHARS
    assert all(msg.instructions is None for msg in history if isinstance(msg, ModelRequest))


def test_follow_up_sees_previous_exchange():
    """ "get it" right after the bot offered coal must reach the model with that offer in context."""
    seen = []

    def respond(messages, info):
        seen.append(texts(messages))
        return ModelResponse(parts=[TextPart('Coal ore below us. Want it?' if len(seen) == 1 else 'On it!')])

    client = TestClient(app)
    with agent.override(model=FunctionModel(respond)):
        client.post('/chat', json={'username': 'Steve', 'message': 'find coal'})
        client.post('/chat', json={'username': 'Steve', 'message': 'get it'})
    assert seen[1] == ['Steve: find coal', 'Coal ore below us. Want it?', 'Steve: get it']


def test_fallback_exchange_keeps_its_tool_call():
    """A run that ended with empty answers is remembered with its tool call, not as words alone."""
    calls = []

    def respond(messages, info):
        calls.append(messages)
        last = messages[-1]
        # The latest thing the player said decides which run this is.
        latest = [p.content for m in messages for p in m.parts if isinstance(p, UserPromptPart)][-1]
        if latest == 'Steve: thanks':
            return ModelResponse(parts=[TextPart('Sure.')])
        if any(isinstance(p, UserPromptPart) for p in last.parts):
            return ModelResponse(parts=[TextPart("I'm on my way!"), ToolCallPart('follow_player', {})])
        return ModelResponse(parts=[TextPart('')])  # every later answer in the "follow me" run is empty

    client = TestClient(app)
    with agent.override(model=FunctionModel(respond)):
        client.post('/chat', json={'username': 'Steve', 'message': 'follow me'})
        client.post('/chat', json={'username': 'Steve', 'message': 'thanks'})
    history = calls[-1]
    assert any(isinstance(p, ToolCallPart) and p.tool_name == 'follow_player' for m in history for p in m.parts)
    assert texts(history)[-2:] == ["I'm on my way!", 'Steve: thanks']


def test_history_is_separate_per_world():
    m = ConversationMemory()
    m.remember('Steve', exchange('Steve: find coal', 'Get it?'), 'seed-a')
    assert m.history('Steve', 'seed-b') == []
    assert texts(m.history('Steve', 'seed-a')) == ['Steve: find coal', 'Get it?']
