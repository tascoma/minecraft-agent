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
