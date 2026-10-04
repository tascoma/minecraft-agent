import pytest
from fastapi.testclient import TestClient
from pydantic_ai.exceptions import ModelAPIError, ModelHTTPError, UsageLimitExceeded
from pydantic_ai.models.function import FunctionModel

from app.agents.agent import agent
from app.core.errors import describe_error
from app.main import app


@pytest.mark.parametrize(
    ('exc', 'status', 'text'),
    [
        (ModelHTTPError(401, 'claude'), 502, 'API key was rejected'),
        (ModelHTTPError(400, 'claude', {'message': 'Your credit balance is too low'}), 502, 'out of credits'),
        (ModelHTTPError(429, 'claude'), 503, 'rate limiting'),
        (ModelHTTPError(529, 'claude'), 503, 'overloaded'),
        (ModelHTTPError(404, 'claude'), 502, 'Claude API error 404'),
        (ModelAPIError('claude', 'connection reset'), 503, "can't reach the Claude API"),
        (UsageLimitExceeded('too many requests'), 500, 'too many steps'),
        (ValueError('boom'), 500, 'Something went wrong'),
    ],
)
def test_describe_error(exc, status, text):
    got_status, message = describe_error(exc)
    assert got_status == status
    assert text in message
    # It has to fit in one Minecraft chat message with the bot's "Error: " prefix.
    assert len(message) < 240


def failing_model(status: int) -> FunctionModel:
    def respond(messages, info):
        raise ModelHTTPError(status, 'claude')

    return FunctionModel(respond)


def test_chat_returns_error_message_when_claude_fails():
    client = TestClient(app, raise_server_exceptions=False)
    with agent.override(model=failing_model(429)):
        res = client.post('/chat', json={'username': 'Steve', 'message': 'hi'})
    assert res.status_code == 503
    assert res.json() == {'error': 'Claude is rate limiting me. Try again in a moment.'}


def test_chat_rejects_malformed_request_with_message():
    client = TestClient(app)
    res = client.post('/chat', json={'username': 'Steve'})
    assert res.status_code == 422
    assert 'out of sync' in res.json()['error']


FOLLOW = {
    'type': 'follow', 'username': 'Steve', 'x': None, 'y': None, 'z': None, 'label': None,
    'item': None, 'count': None,
}


def test_reply_written_next_to_tool_call_is_used():
    """What Haiku does: reply text alongside the tool call, then an empty answer to the tool result.
    Retrying makes it call the tool again, so the bot must get one action and the earlier text."""
    from pydantic_ai.messages import ModelRequest, ModelResponse, TextPart, ToolCallPart, ToolReturnPart

    def respond(messages, info):
        last = messages[-1]
        if isinstance(last, ModelRequest) and any(isinstance(p, ToolReturnPart) for p in last.parts):
            return ModelResponse(parts=[TextPart('')])
        return ModelResponse(parts=[TextPart("I'm on my way!"), ToolCallPart('follow_player', {})])

    client = TestClient(app)
    with agent.override(model=FunctionModel(respond)):
        res = client.post('/chat', json={'username': 'Steve', 'message': 'follow me'})
    assert res.status_code == 200
    assert res.json()['reply'] == "I'm on my way!"
    assert res.json()['actions'] == [FOLLOW]


def test_actions_survive_when_model_never_writes_text():
    from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart

    def respond(messages, info):
        if len(messages) == 1:
            return ModelResponse(parts=[ToolCallPart('follow_player', {})])
        return ModelResponse(parts=[TextPart('')])

    client = TestClient(app)
    with agent.override(model=FunctionModel(respond)):
        res = client.post('/chat', json={'username': 'Steve', 'message': 'follow me'})
    assert res.status_code == 200
    assert res.json()['reply'] == 'On it!'
    assert res.json()['actions'] == [FOLLOW]


def test_empty_reply_without_actions_is_still_an_error():
    from pydantic_ai.messages import ModelResponse, TextPart

    client = TestClient(app, raise_server_exceptions=False)
    with agent.override(model=FunctionModel(lambda messages, info: ModelResponse(parts=[TextPart('')]))):
        res = client.post('/chat', json={'username': 'Steve', 'message': 'hi'})
    assert res.status_code == 500
    assert 'confused' in res.json()['error']
