from typing import Literal

from pydantic import BaseModel


class ChatRequest(BaseModel):
    username: str
    message: str


class BotAction(BaseModel):
    """Something the bot should do in the world besides chatting."""

    type: Literal['follow', 'stay']
    username: str | None = None


class ChatResponse(BaseModel):
    reply: str
    actions: list[BotAction] = []
