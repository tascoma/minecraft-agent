import logging
import time

from fastapi import APIRouter
from pydantic_ai import capture_run_messages
from pydantic_ai.exceptions import UnexpectedModelBehavior
from pydantic_ai.messages import ModelMessage, ModelRequest, ModelResponse, TextPart, ToolCallPart, ToolReturnPart
from pydantic_ai.usage import RunUsage

from app.agents.agent import ChatDeps, agent
from app.schema.chat import BotAction, ChatRequest, ChatResponse, ProtectedSpot
from app.services import world
from app.services.memory import memory
from app.core.config import get_settings
from app.services.budget import Budget, basic_command
from app.services.chests import Chest, get_chest_store
from app.services.journal import Event, get_journal
from app.services.places import get_place_store, protected_spots

logger = logging.getLogger(__name__)
router = APIRouter()

# Said in chat when the agent's tools ran but it never wrote any reply text at all.
FALLBACK_REPLY = 'On it!'

settings = get_settings()
budget = Budget(settings.budget_dollars_per_hour, settings.model_name)


def usage_of(messages: list[ModelMessage]) -> RunUsage:
    """The token usage of a run's model responses, for a run that failed before giving a result."""
    usage = RunUsage()
    for message in messages:
        if isinstance(message, ModelResponse):
            usage.incr(message.usage)
    return usage


def over_budget(request: ChatRequest) -> ChatResponse:
    """The reply when the hour's Claude budget is spent: handle the basic commands without the agent."""
    wait = f'about {budget.minutes_until_free()} min'
    command = basic_command(request.message)
    if command == 'stay':
        return ChatResponse(reply='Stopping.', actions=[BotAction(type='stay')])
    if command in ('follow', 'come'):
        return ChatResponse(reply='Coming!', actions=[BotAction(type=command, username=request.username)])
    return ChatResponse(
        reply=f"I've used my thinking budget for this hour, so I can only follow, stay or come for {wait}. "
        'I still fight, eat and keep myself safe.'
    )


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
async def places(world: str | None = None) -> list[ProtectedSpot]:
    """Saved places of one world, fetched by the bot when it joins so its no-digging zones are right from the start."""
    return protected_spots(get_place_store(world or None))


@router.get('/chests')
async def chests(world: str | None = None) -> list[Chest]:
    """Every chest the bot remembers in a world, fetched when it joins so it knows where things are."""
    return get_chest_store(world or None).all()


@router.post('/chests')
async def save_chest(chest: Chest, world: str | None = None) -> None:
    """The bot reports a chest's contents each time it opens one."""
    get_chest_store(world or None).save(chest)


@router.delete('/chests')
async def forget_chest(x: int, y: int, z: int, dimension: str, world: str | None = None) -> None:
    """The bot found a chest it remembered gone (broken, or never there again)."""
    get_chest_store(world or None).remove(x, y, z, dimension)


@router.post('/events')
async def record_event(event: Event, world: str | None = None) -> None:
    """The bot reports something that happened (a job finished, it died, it changed dimension).
    Just recorded for the agent to read later; no model call."""
    get_journal(world or None).record(event)


@router.post('/chat')
async def chat(request: ChatRequest) -> ChatResponse:
    logger.info('chat from %s: %s', request.username, request.message)
    if budget.exhausted():
        logger.warning('over the budget of $%.2f/hour (spent $%.3f); not calling the agent', budget.dollars_per_hour, budget.spent())
        return over_budget(request)
    if request.state:
        logger.info(world.describe_status(request.state))
    started = time.perf_counter()
    world_id = request.state.world_id if request.state else None
    deps = ChatDeps(username=request.username, state=request.state)
    prompt = f'{request.username}: {request.message}'
    with capture_run_messages() as messages:
        try:
            result = await agent.run(prompt, deps=deps, message_history=memory.history(request.username, world_id))
        except UnexpectedModelBehavior:
            log_messages(messages, failed=True)
            budget.record(usage_of(messages))
            # The tools already did their job (e.g. queued "follow"); don't throw that away
            # just because the model ended with an empty message. Use what it said earlier.
            if deps.actions:
                reply = last_text(messages) or FALLBACK_REPLY
                logger.warning('agent ended without a reply; sending its actions with: %s', reply)
                memory.remember_fallback(request.username, messages, reply, world_id)
                return ChatResponse(
                    reply=reply, actions=unique_actions(deps.actions), protected_places=protected_spots(deps.places)
                )
            logger.exception('agent run failed for message from %s', request.username)
            raise
        except Exception:
            log_messages(messages, failed=True)
            budget.record(usage_of(messages))
            logger.exception('agent run failed for message from %s', request.username)
            raise

    log_messages(result.new_messages())
    memory.remember(request.username, result.new_messages(), world_id)
    usage = result.usage
    cost = budget.record(usage)
    logger.info(
        'reply to %s (%.1fs, %d in (%d cached, %d cache writes) / %d out tokens, %d requests, $%.4f, $%.3f this hour): %s',
        request.username,
        time.perf_counter() - started,
        usage.input_tokens,
        usage.cache_read_tokens,
        usage.cache_write_tokens,
        usage.output_tokens,
        usage.requests,
        cost,
        budget.spent(),
        result.output,
    )
    return ChatResponse(
        reply=result.output, actions=unique_actions(deps.actions), protected_places=protected_spots(deps.places)
    )
