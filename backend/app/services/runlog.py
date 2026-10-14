import json
import logging

from pydantic_ai.messages import ModelMessage, ModelResponse, ThinkingPart, ToolCallPart
from pydantic_ai.usage import RunUsage

logger = logging.getLogger('app.run')

# What started the run. `scripts/token-report.py` groups by this.
KINDS = ('chat', 'event', 'fallback', 'error', 'over_budget')


def log_run(
    kind: str,
    *,
    username: str,
    model: str,
    effort: str | None = None,
    seconds: float = 0.0,
    usage: RunUsage | None = None,
    cost: float = 0.0,
    messages: list[ModelMessage] | None = None,
) -> None:
    """Write one `run {json}` line per agent run, whether it succeeded, fell back or was never started,
    so the logs can be grepped and summed. Thinking is reported separately from the output tokens,
    which include it."""
    tools: list[str] = []
    thinking_parts = thinking_chars = 0
    for message in messages or []:
        if not isinstance(message, ModelResponse):
            continue
        for part in message.parts:
            if isinstance(part, ToolCallPart):
                tools.append(part.tool_name)
            elif isinstance(part, ThinkingPart):
                thinking_parts += 1
                thinking_chars += len(part.content or '')
    usage = usage or RunUsage()
    record = {
        'kind': kind,
        'user': username,
        'model': model,
        'effort': effort,
        'seconds': round(seconds, 2),
        'input': usage.input_tokens,
        'cached': usage.cache_read_tokens,
        'cache_writes': usage.cache_write_tokens,
        'output': usage.output_tokens,
        'requests': usage.requests,
        'cost': round(cost, 6),
        'tools': tools,
        'thinking_parts': thinking_parts,
        'thinking_chars': thinking_chars,
    }
    logger.info('run %s', json.dumps(record))
