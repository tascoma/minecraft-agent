from typing import Literal

from pydantic import BaseModel


class Position(BaseModel):
    x: int
    y: int
    z: int


class ItemStack(BaseModel):
    name: str
    count: int


class BlockSighting(BaseModel):
    """All blocks of one type near the bot, and where the nearest one is."""

    name: str
    count: int
    # True when the bot stopped counting at its limit, so there are at least `count`.
    more: bool = False
    nearest: Position
    distance: float


class EntitySighting(BaseModel):
    name: str
    # Mineflayer's entity type ('player', 'hostile', 'animal', ...), or 'item' for dropped items.
    kind: str
    distance: float
    position: Position
    # Stack size, for dropped items only.
    count: int | None = None


class BotState(BaseModel):
    """Snapshot of the bot's situation, sent by the bot with each chat message."""

    health: float
    food: int
    position: Position
    dimension: str
    # Ticks since sunrise, 0 to 23999. Night runs from about 13000 to 23000.
    time_of_day: int
    raining: bool
    thundering: bool
    held_item: str | None = None
    inventory: list[ItemStack] = []
    nearby_blocks: list[BlockSighting] = []
    nearby_entities: list[EntitySighting] = []
    # Where the player who is talking is, or None when the bot can't see them.
    player_position: Position | None = None
    player_distance: float | None = None


class ChatRequest(BaseModel):
    username: str
    message: str
    # Optional so the backend still works with a bot that doesn't send state.
    state: BotState | None = None


class BotAction(BaseModel):
    """Something the bot should do in the world besides chatting.

    follow/come: `username` is the player. goto: `x`, `z`, optional `y`, and an optional `label` the bot
    uses when it reports arriving ("Made it to home.").
    """

    type: Literal['follow', 'stay', 'come', 'goto']
    username: str | None = None
    x: int | None = None
    y: int | None = None
    z: int | None = None
    label: str | None = None


class ChatResponse(BaseModel):
    reply: str
    actions: list[BotAction] = []
