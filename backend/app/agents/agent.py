from dataclasses import dataclass, field

from pydantic_ai import Agent, RunContext
from pydantic_ai.models.anthropic import AnthropicModel
from pydantic_ai.providers.anthropic import AnthropicProvider
from pydantic_ai.workspaces import LocalWorkspaceBackend
from pydantic_ai_harness.skills import Skills

from app.core.config import REPO_ROOT, get_settings
from app.schema.chat import BotAction, BotState
from app.services import world
from app.services.places import Place, PlaceStore, get_place_store

settings = get_settings()


@dataclass
class ChatDeps:
    username: str
    # None when the bot didn't send its state (e.g. an older bot or a test request).
    state: BotState | None = None
    actions: list[BotAction] = field(default_factory=list)
    places: PlaceStore = field(default_factory=get_place_store)


agent = Agent(
    AnthropicModel(
        settings.model_name,
        provider=AnthropicProvider(api_key=settings.anthropic_api_key.get_secret_value()),
    ),
    deps_type=ChatDeps,
    # Haiku often writes its reply next to a tool call and then answers the tool result with nothing.
    # Retrying makes it call the tool again, so don't retry much; the /chat route falls back to that
    # earlier text instead.
    retries={'output': 1},
    instructions=(
        'You are a friendly Minecraft companion who plays alongside the user in their world. '
        'Your replies are sent as in-game chat, so keep them short: one or two sentences, plain text, no Markdown. '
        'You follow the player around by default. Use your movement tools when the player asks you to follow, stop, come over, '
        'or go somewhere. Moves happen after your reply and the bot announces in chat whether they worked, '
        'so say you are on your way, never that you have arrived or teleported. '
        'If the player asks for something new while you are busy with a job, do the new thing: it replaces the '
        'current job, unless they say to finish first. '
        'Use your lookup tools to check your inventory and surroundings before answering questions about them; never guess. '
        'Earlier messages show what happened before, not now: your status line is the current truth, and when the player '
        'asks for something again, call the tool again instead of assuming it is already done.'
    ),
    # Skills reads SKILL.md files through its own workspace, so the agent gets no file tools.
    capabilities=[Skills(settings.skills_dir, workspace=LocalWorkspaceBackend(REPO_ROOT))],
)


@agent.tool
def follow_player(ctx: RunContext[ChatDeps]) -> str:
    """Start following the player who is talking to you, staying a few blocks behind them."""
    ctx.deps.actions.append(BotAction(type='follow', username=ctx.deps.username))
    return f'Now following {ctx.deps.username}.'


@agent.tool
def stay_here(ctx: RunContext[ChatDeps]) -> str:
    """Stop whatever you're doing (following, walking somewhere) and stand still. Use for "stop", "wait" and "stay here"."""
    ctx.deps.actions.append(BotAction(type='stay'))
    return 'Stopped. Standing still.'


@agent.tool
def come_here(ctx: RunContext[ChatDeps]) -> str:
    """Walk over to the player who is talking to you once, then wait next to them (not follow)."""
    ctx.deps.actions.append(BotAction(type='come', username=ctx.deps.username))
    return f'Walking over to {ctx.deps.username}.'


@agent.tool
def teleport_to_player(ctx: RunContext[ChatDeps]) -> str:
    """Teleport instantly next to the player who is talking to you, using /tp.

    Only when they ask you to teleport. Needs commands allowed in the world; the bot says if it fails.
    """
    ctx.deps.actions.append(BotAction(type='teleport', username=ctx.deps.username))
    return 'Teleport requested. The bot will say in chat whether it worked, so do not say you have teleported.'


@agent.tool
def recover_items(ctx: RunContext[ChatDeps]) -> str:
    """Go back to where you last died and pick up your dropped items. Items vanish 5 minutes after death.

    Only when the player asks you to get your things back.
    """
    ctx.deps.actions.append(BotAction(type='recover'))
    return 'Going back for the items. The bot will say in chat how it went.'


@agent.tool
def collect(ctx: RunContext[ChatDeps], item: str, count: int) -> str:
    """Gather an item by breaking the blocks that drop it, e.g. "log" (any tree), "oak_log", "cobblestone",
    "dirt", "sand", "gravel", "coal", "raw_iron". Count is 1 to 64.

    Stone and coal need a pickaxe and iron a stone pickaxe or better; if you don't have one you make it
    first. You dig only while gathering, never near saved places, and never through blocks a player
    placed. It takes a while and replaces whatever you were doing; the bot reports progress in chat.
    """
    ctx.deps.actions.append(BotAction(type='collect', item=item, count=count))
    return f'Started gathering {count} {item}. The bot will report how it goes, so do not claim it is done.'


@agent.tool
def make_item(ctx: RunContext[ChatDeps], item: str, count: int = 1) -> str:
    """Craft or smelt an item, e.g. "stone_pickaxe", "torch", "chest", "furnace", "iron_ingot", "glass",
    "cooked_beef". Use the item's Minecraft name. Count is 1 to 64.

    You work out the whole chain yourself: planks from logs, sticks, a crafting table or furnace (placed
    and picked back up), and you gather missing materials, making any tool you need to mine them. It
    takes a while and replaces whatever you were doing; the bot reports progress and the result in chat.
    """
    ctx.deps.actions.append(BotAction(type='make', item=item, count=count))
    return f'Started making {count} {item}. The bot will report how it goes, so do not claim it is done.'


@agent.tool
def give_items(ctx: RunContext[ChatDeps], item: str, count: int | None = None) -> str:
    """Walk to the player who is talking to you and toss them an item from your inventory.

    Leave count out to give all of it. Check your inventory first if you're not sure you have it.
    """
    ctx.deps.actions.append(BotAction(type='give', username=ctx.deps.username, item=item, count=count))
    return f'Bringing {ctx.deps.username} the {item}. The bot will say what it handed over.'


@agent.tool
def go_to(ctx: RunContext[ChatDeps], x: int, z: int, y: int | None = None) -> str:
    """Walk to coordinates and wait there. Leave y out if the player only gave x and z."""
    ctx.deps.actions.append(BotAction(type='goto', x=x, y=y, z=z))
    return f'Walking to ({x}, {z}).' if y is None else f'Walking to ({x}, {y}, {z}).'


@agent.tool
def save_place(ctx: RunContext[ChatDeps], name: str) -> str:
    """Remember where the player is standing under a name, like "home" or "mine", to go back later.

    Replaces any place with the same name. Uses your own position if you can't see the player.
    """
    state = ctx.deps.state
    if not state:
        return NO_STATE
    pos, whose = (state.player_position, 'their') if state.player_position else (state.position, 'your')
    ctx.deps.places.save(Place(name=name, x=pos.x, y=pos.y, z=pos.z, dimension=state.dimension))
    return f'Saved "{name}" at {world.format_position(pos)} in {world.describe_dimension(state.dimension)} ({whose} position).'


@agent.tool
def go_to_place(ctx: RunContext[ChatDeps], name: str) -> str:
    """Walk to a saved place and wait there."""
    place = ctx.deps.places.get(name)
    if not place:
        known = ', '.join(p.name for p in ctx.deps.places.all()) or 'none yet'
        return f'No saved place called "{name}". Saved places: {known}.'
    if ctx.deps.state and place.dimension != ctx.deps.state.dimension:
        here = world.describe_dimension(ctx.deps.state.dimension)
        return f'{place.name} is in {world.describe_dimension(place.dimension)}, but you are in {here}.'
    ctx.deps.actions.append(BotAction(type='goto', x=place.x, y=place.y, z=place.z, label=place.name))
    return f'Walking to {place.name} at ({place.x}, {place.y}, {place.z}).'


@agent.tool
def forget_place(ctx: RunContext[ChatDeps], name: str) -> str:
    """Delete a saved place."""
    if ctx.deps.places.remove(name):
        return f'Forgot "{name}".'
    return f'No saved place called "{name}".'


NO_STATE = "You can't sense the world right now."


@agent.instructions
def status(ctx: RunContext[ChatDeps]) -> str:
    """Health, hunger, position, time and weather, so every reply can take them into account."""
    return world.describe_status(ctx.deps.state) if ctx.deps.state else NO_STATE


@agent.instructions
def saved_places(ctx: RunContext[ChatDeps]) -> str:
    """Saved place names, so the agent knows what "go home" refers to without a lookup."""
    return world.describe_places(ctx.deps.places.all(), ctx.deps.state)


@agent.tool
def check_inventory(ctx: RunContext[ChatDeps]) -> str:
    """List the items in your inventory."""
    return world.describe_inventory(ctx.deps.state) if ctx.deps.state else NO_STATE


@agent.tool
def look_around(ctx: RunContext[ChatDeps]) -> str:
    """List notable blocks within 32 blocks: ores, trees, water, lava, sand, gravel, crafting tables, furnaces, chests and beds."""
    return world.describe_blocks(ctx.deps.state) if ctx.deps.state else NO_STATE


@agent.tool
def nearby_entities(ctx: RunContext[ChatDeps]) -> str:
    """List mobs, animals, players and dropped items within 32 blocks, nearest first."""
    return world.describe_entities(ctx.deps.state) if ctx.deps.state else NO_STATE


@agent.tool
def where_are_we(ctx: RunContext[ChatDeps]) -> str:
    """Give your coordinates, and where the player talking to you is and how far away."""
    return world.describe_location(ctx.deps.state, ctx.deps.username) if ctx.deps.state else NO_STATE
