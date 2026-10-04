import logging
import time

from fastapi import APIRouter
from pydantic_ai import capture_run_messages
from pydantic_ai.exceptions import UnexpectedModelBehavior
from pydantic_ai.messages import ModelMessage, ModelRequest, ModelResponse, TextPart, ToolCallPart, ToolReturnPart

from app.agents.agent import ChatDeps, agent
from app.schema.chat import BotAction, ChatRequest, ChatResponse, ProtectedSpot
from app.services import world
from app.services.memory import memory
from app.services.places import get_place_store, protected_spots

logger = logging.getLogger(__name__)
router = APIRouter()

# Said in chat when the agent's tools ran but it never wrote any reply text at all.
FALLBACK_REPLY = 'On it!'


def last_text(messages: list[ModelMessage]) -> str | None:
    """The last thing the model wrote, even if it came alongside a tool call rather than as the final answer."""
    for message in reversed(messages):
        if isinstance(message, ModelResponse):
            for part in reversed(message.parts):
                if isinstance(part, TextPart) and part.content.strip():
                    return part.content.strip()
    return None


def unique_actions(actions: list[BotAction]) -> list[BotAction]:
    """Drop back-to-back repeats: when the model retries it often calls the same tool again.
    Non-adjacent repeats stay, so "follow, stay, follow" still ends with following."""
    return [a for i, a in enumerate(actions) if i == 0 or a != actions[i - 1]]


def log_messages(messages: list[ModelMessage], *, failed: bool = False) -> None:
    for message in messages:
        for part in message.parts:
            if isinstance(message, ModelResponse) and isinstance(part, ToolCallPart):
                logger.info('tool call %s(%s)', part.tool_name, part.args_as_json_str())
            elif isinstance(message, ModelRequest) and isinstance(part, ToolReturnPart):
                logger.info('tool result %s: %s', part.tool_name, part.model_response_str())
            elif failed and isinstance(part, TextPart):
                logger.info('model text: %r', part.content)
        # A failed run is often the model answering with nothing at all; make that visible.
        if failed and isinstance(message, ModelResponse) and not any(p.has_content() for p in message.parts):
            logger.info('model returned an empty response')


@router.get('/places')
async def places() -> list[ProtectedSpot]:
    """Saved places, fetched by the bot when it joins so its no-digging zones are right from the start."""
    return protected_spots(get_place_store())


@router.post('/chat')
async def chat(request: ChatRequest) -> ChatResponse:
    logger.info('chat from %s: %s', request.username, request.message)
    if request.state:
        logger.info(world.describe_status(request.state))
    started = time.perf_counter()
    deps = ChatDeps(username=request.username, state=request.state)
    prompt = f'{request.username}: {request.message}'
    with capture_run_messages() as messages:
        try:
            result = await agent.run(prompt, deps=deps, message_history=memory.history(request.username))
        except UnexpectedModelBehavior:
            log_messages(messages, failed=True)
            # The tools already did their job (e.g. queued "follow"); don't throw that away
            # just because the model ended with an empty message. Use what it said earlier.
            if deps.actions:
                reply = last_text(messages) or FALLBACK_REPLY
                logger.warning('agent ended without a reply; sending its actions with: %s', reply)
                memory.remember_fallback(request.username, messages, reply)
                return ChatResponse(
                    reply=reply, actions=unique_actions(deps.actions), protected_places=protected_spots(deps.places)
                )
            logger.exception('agent run failed for message from %s', request.username)
            raise
        except Exception:
            log_messages(messages, failed=True)
            logger.exception('agent run failed for message from %s', request.username)
            raise

    log_messages(result.new_messages())
    memory.remember(request.username, result.new_messages())
    usage = result.usage
    logger.info(
        'reply to %s (%.1fs, %d in / %d out tokens): %s',
        request.username,
        time.perf_counter() - started,
        usage.input_tokens,
        usage.output_tokens,
        result.output,
    )
    return ChatResponse(
        reply=result.output, actions=unique_actions(deps.actions), protected_places=protected_spots(deps.places)
    )
