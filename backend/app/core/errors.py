"""Turns failures into short messages the bot can say in Minecraft chat.

Error responses are JSON `{"error": "<message>"}`; the bot shows `error` to the player.
"""

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic_ai.exceptions import (
    ModelAPIError,
    ModelHTTPError,
    UnexpectedModelBehavior,
    UsageLimitExceeded,
)

logger = logging.getLogger(__name__)


def describe_error(exc: Exception) -> tuple[int, str]:
    """HTTP status and chat message for an exception. Messages must fit in one chat line."""
    match exc:
        case ModelHTTPError(status_code=401 | 403):
            return 502, 'My Claude API key was rejected. Check ANTHROPIC_API_KEY in .env.'
        case ModelHTTPError(status_code=400) if 'credit balance' in str(exc.body):
            return 502, 'The Anthropic account is out of credits.'
        case ModelHTTPError(status_code=429):
            return 503, 'Claude is rate limiting me. Try again in a moment.'
        case ModelHTTPError(status_code=status) if status >= 500:
            return 503, 'Claude is overloaded or down right now. Try again in a moment.'
        case ModelHTTPError(status_code=status):
            return 502, f'Claude API error {status}. Details are in backend/logs/agent.log.'
        case ModelAPIError():
            return 503, "I can't reach the Claude API. Check the internet connection."
        case UsageLimitExceeded():
            return 500, 'That took me too many steps, so I gave up.'
        case UnexpectedModelBehavior():
            return 500, "I got confused by Claude's answer. Try asking another way."
        case RequestValidationError():
            return 422, "My backend didn't understand the bot's request. Are the bot and backend out of sync?"
        case _:
            return 500, 'Something went wrong in my backend. Details are in backend/logs/agent.log.'


async def handle_error(request: Request, exc: Exception) -> JSONResponse:
    status, message = describe_error(exc)
    if isinstance(exc, RequestValidationError):
        logger.warning('invalid request to %s: %s', request.url.path, exc.errors())
    else:
        logger.error('%s failed: %r', request.url.path, exc)
    return JSONResponse(status_code=status, content={'error': message})


def register_error_handlers(app: FastAPI) -> None:
    app.add_exception_handler(RequestValidationError, handle_error)
    app.add_exception_handler(Exception, handle_error)
