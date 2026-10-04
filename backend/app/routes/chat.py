import logging
import time

from fastapi import APIRouter
from pydantic_ai.messages import ModelRequest, ModelResponse, ToolCallPart, ToolReturnPart

from app.agents.agent import ChatDeps, agent
from app.schema.chat import ChatRequest, ChatResponse
from app.services import world

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post('/chat')
async def chat(request: ChatRequest) -> ChatResponse:
    logger.info('chat from %s: %s', request.username, request.message)
    if request.state:
        logger.info(world.describe_status(request.state))
    started = time.perf_counter()
    deps = ChatDeps(username=request.username, state=request.state)
    try:
        result = await agent.run(f'{request.username}: {request.message}', deps=deps)
    except Exception:
        logger.exception('agent run failed for message from %s', request.username)
        raise

    for message in result.new_messages():
        for part in message.parts:
            if isinstance(message, ModelResponse) and isinstance(part, ToolCallPart):
                logger.info('tool call %s(%s)', part.tool_name, part.args_as_json_str())
            elif isinstance(message, ModelRequest) and isinstance(part, ToolReturnPart):
                logger.info('tool result %s: %s', part.tool_name, part.model_response_str())

    usage = result.usage
    logger.info(
        'reply to %s (%.1fs, %d in / %d out tokens): %s',
        request.username,
        time.perf_counter() - started,
        usage.input_tokens,
        usage.output_tokens,
        result.output,
    )
    return ChatResponse(reply=result.output, actions=deps.actions)
