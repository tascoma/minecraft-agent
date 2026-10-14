"""Chat the agent doesn't need to see: exact one-word commands and small talk.

A call that never happens costs nothing and answers at once. Both lists are exact matches on the
whole message (give or take punctuation, case and "please"), so "stop following and get wood" is
never mistaken for "stop" and still goes to the agent.
"""

import re
from dataclasses import dataclass
from uuid import uuid4

from pydantic_ai.messages import ModelMessage, ModelRequest, ModelResponse, TextPart, ToolCallPart, ToolReturnPart, UserPromptPart


@dataclass(frozen=True)
class FastCommand:
    # The agent tool this stands in for and what that tool returns, so the remembered exchange looks
    # exactly like one the agent ran (tool calls must stay in history, see memory.py).
    tool: str
    tool_result: str
    # What the bot says.
    reply: str
    phrases: frozenset[str]


# `{username}` in tool_result is the player talking.
COMMANDS = {
    'stay': FastCommand(
        tool='stay_here',
        tool_result='Stopped. Standing still.',
        reply='Stopping.',
        phrases=frozenset({'stop', 'stay', 'wait', 'halt', 'stay here', 'stop here', 'wait here'}),
    ),
    'follow': FastCommand(
        tool='follow_player',
        tool_result='Now following {username}.',
        reply='Following you!',
        phrases=frozenset({'follow', 'follow me'}),
    ),
    'come': FastCommand(
        tool='come_here',
        tool_result='Walking over to {username}.',
        reply='Coming!',
        phrases=frozenset({'come', 'come here', 'come to me'}),
    ),
}
PHRASES = {phrase: name for name, command in COMMANDS.items() for phrase in command.phrases}

# Said to nobody in particular; the bot stays quiet rather than answering every "lol".
SMALL_TALK = frozenset({'ok', 'okay', 'k', 'kk', 'ty', 'thx', 'thanks', 'thank you', 'nice', 'cool', 'gg', 'np', 'brb'})
LAUGHTER = re.compile(r'^(lo+l+|lmao+|ha(ha)+h?|he(he)+h?)$')
FILLER = frozenset({'please', 'pls', 'plz'})


def normalize(message: str) -> str:
    """Lowercase, without punctuation or "please": "Follow me, please!" -> "follow me"."""
    words = re.sub(r'[^\w\s]', ' ', message.lower()).split()
    return ' '.join(w for w in words if w not in FILLER)


def exact_command(message: str) -> str | None:
    """'stay', 'follow' or 'come' when the whole message is just that command, else None."""
    return PHRASES.get(normalize(message))


def is_small_talk(message: str) -> bool:
    """Laughter, "ok", "thanks", or only emoji and symbols (a lone "?" is a question, not small talk)."""
    text = normalize(message)
    if text in SMALL_TALK or LAUGHTER.match(text):
        return True
    stripped = message.strip()
    return bool(stripped) and not any(c.isalnum() for c in stripped) and '?' not in stripped


def exchange(command: str, prompt: str, username: str) -> list[ModelMessage]:
    """The messages an agent run would have left behind for this command: the prompt, the tool call
    and its result, and the reply."""
    spec = COMMANDS[command]
    call_id = f'fast_{uuid4().hex[:12]}'
    return [
        ModelRequest(parts=[UserPromptPart(content=prompt)]),
        ModelResponse(parts=[ToolCallPart(tool_name=spec.tool, args={}, tool_call_id=call_id)]),
        ModelRequest(
            parts=[ToolReturnPart(tool_name=spec.tool, content=spec.tool_result.format(username=username), tool_call_id=call_id)]
        ),
        ModelResponse(parts=[TextPart(content=spec.reply)]),
    ]
