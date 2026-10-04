"""Short-term conversation memory, so a follow-up like "get it" makes sense.

Keeps each player's last few exchanges (their message, any tool calls, and the bot's reply), in memory
only. Tool calls must stay in: with replies alone, the model learns that saying "On my way to get logs!"
is enough and stops calling the tools.
"""

import time
from dataclasses import dataclass, field, replace

from pydantic_ai.messages import ModelMessage, ModelRequest, ModelResponse, TextPart, ToolReturnPart

# How many exchanges to remember per player.
MAX_EXCHANGES = 5
# Forget a conversation after this long without a message, in seconds.
IDLE_SECONDS = 600
# Tool results like look_around can be long; the gist is enough for context.
MAX_TOOL_RESULT_CHARS = 300


def compact(messages: list[ModelMessage]) -> list[ModelMessage]:
    """Shorten an exchange for keeping: trim long tool results and drop the per-run instructions
    (the status line etc. is out of date by the next message; the agent gets fresh ones)."""
    kept: list[ModelMessage] = []
    for message in messages:
        if isinstance(message, ModelRequest):
            parts = [
                replace(p, content=p.model_response_str()[:MAX_TOOL_RESULT_CHARS])
                if isinstance(p, ToolReturnPart) else p
                for p in message.parts
            ]
            kept.append(replace(message, parts=parts, instructions=None))
        else:
            kept.append(message)
    return kept


@dataclass
class Conversation:
    exchanges: list[list[ModelMessage]] = field(default_factory=list)
    last_active: float = 0.0


class ConversationMemory:
    def __init__(self, clock=time.monotonic) -> None:
        self._clock = clock
        self._conversations: dict[str, Conversation] = {}

    def history(self, username: str) -> list[ModelMessage]:
        """The recent exchanges with this player, as message history for the agent."""
        conversation = self._conversations.get(username)
        if not conversation or self._clock() - conversation.last_active > IDLE_SECONDS:
            self._conversations.pop(username, None)
            return []
        return [message for exchange in conversation.exchanges for message in exchange]

    def remember(self, username: str, messages: list[ModelMessage]) -> None:
        """Keep one exchange: the messages of a single agent run."""
        conversation = self._conversations.setdefault(username, Conversation())
        if self._clock() - conversation.last_active > IDLE_SECONDS:
            conversation.exchanges.clear()
        conversation.exchanges = [*conversation.exchanges, compact(messages)][-MAX_EXCHANGES:]
        conversation.last_active = self._clock()

    def remember_fallback(self, username: str, messages: list[ModelMessage], reply: str) -> None:
        """Keep a run that ended without a reply (the route sent `reply` instead): the message and the
        first round of tool calls and results, then that reply. Drops the empty answers and retries."""
        kept = messages[:1]
        for i, message in enumerate(messages):
            if isinstance(message, ModelRequest) and any(isinstance(p, ToolReturnPart) for p in message.parts):
                kept = messages[: i + 1]
                break
        self.remember(username, [*kept, ModelResponse(parts=[TextPart(content=reply)])])


memory = ConversationMemory()
