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
    # The saved places of the world the bot is in; picked from the state's world id unless given.
    places: PlaceStore = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.places is None:
            self.places = get_place_store(self.state.world_id if self.state else None)


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
    and picked back up), and you gather missing materials, making any tool you need to mine them. For
    cooked meat you hunt the animal first if you have no raw meat. It
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
def attack(ctx: RunContext[ChatDeps], target: str | None = None) -> str:
    """Attack a mob, e.g. "zombie", "skeleton", "cow". Leave target out for the nearest hostile mob.

    Use it whenever the player asks you to kill or hunt something, including farm animals for food
    (cows, pigs, chickens, sheep). You already fight back and defend the player by yourself. The bot
    refuses players, villagers, golems and pets on its own, and backs away from creepers.
    """
    ctx.deps.actions.append(BotAction(type='attack', target=target))
    what = f'the {target}' if target else 'the nearest hostile mob'
    return f'Going after {what}. The bot will say in chat how it went, so do not claim it is dead.'


@agent.tool
def guard_area(ctx: RunContext[ChatDeps], place: str | None = None) -> str:
    """Stand guard at a saved place (e.g. "home", "base") or, with no place, where the player is standing.

    You fight hostile mobs that come within 12 blocks and go back to your post after each fight,
    until the player tells you to do something else.
    """
    if place:
        saved = ctx.deps.places.get(place)
        if not saved:
            known = ', '.join(p.name for p in ctx.deps.places.all()) or 'none yet'
            return f'No saved place called "{place}". Saved places: {known}.'
        if ctx.deps.state and saved.dimension != ctx.deps.state.dimension:
            return f'{saved.name} is in {world.describe_dimension(saved.dimension)}, not here.'
        ctx.deps.actions.append(BotAction(type='guard', x=saved.x, y=saved.y, z=saved.z, label=saved.name))
        return f'Heading to guard {saved.name}. The bot will say in chat when it is on guard.'
    state = ctx.deps.state
    if not state:
        return NO_STATE
    pos = state.player_position or state.position
    ctx.deps.actions.append(BotAction(type='guard', x=pos.x, y=pos.y, z=pos.z))
    return f'Guarding {world.format_position(pos)}. The bot will say in chat when it is on guard.'


@agent.tool
def hunt(ctx: RunContext[ChatDeps], animal: str, count: int = 1) -> str:
    """Hunt animals for food or leather and pick up what they drop: "cow", "pig", "chicken", "sheep",
    "rabbit". Count is 1 to 64. You skip babies and leave the last two of a kind so they can breed.
    """
    ctx.deps.actions.append(BotAction(type='hunt', target=animal, count=count))
    return f'Started hunting {count} {animal}. The bot will report how it goes, so do not claim it is done.'


@agent.tool
def harvest_crops(ctx: RunContext[ChatDeps], crop: str | None = None) -> str:
    """Harvest every ripe crop within 32 blocks (wheat, carrots, potatoes, beetroots) and replant them.
    Leave crop out to harvest all kinds.
    """
    ctx.deps.actions.append(BotAction(type='harvest', target=crop))
    return 'Started harvesting. The bot will report how many it got, so do not claim it is done.'


@agent.tool
def plant_crops(ctx: RunContext[ChatDeps], crop: str = 'wheat', count: int = 16) -> str:
    """Plant a crop ("wheat", "carrots", "potatoes", "beetroots"): on empty farmland first, then by
    tilling dirt next to water (you make a hoe if you need one). For wheat you break grass for seeds
    if you have none; carrots and potatoes must be in your inventory. Count is 1 to 64.
    """
    ctx.deps.actions.append(BotAction(type='plant', target=crop, count=count))
    return f'Started planting {count} {crop}. The bot will report how it goes, so do not claim it is done.'


@agent.tool
def breed_animals(ctx: RunContext[ChatDeps], animal: str) -> str:
    """Feed two grown animals of a kind so they have a baby: cows, sheep and goats eat wheat, pigs
    carrots, potatoes or beetroot, chickens seeds, rabbits carrots. Needs 2 of the food.
    """
    ctx.deps.actions.append(BotAction(type='breed', target=animal))
    return f'Going to breed {animal}. The bot will say how it went.'


@agent.tool
def go_fishing(ctx: RunContext[ChatDeps], count: int = 5) -> str:
    """Fish in open water nearby until you catch `count` things (1 to 64). Needs a fishing rod; you make
    one if you have string.
    """
    ctx.deps.actions.append(BotAction(type='fish', count=count))
    return f'Going fishing for {count}. The bot will report what it catches, so do not claim it caught anything.'


@agent.tool
def shear_sheep(ctx: RunContext[ChatDeps], count: int = 64) -> str:
    """Shear the woolly sheep nearby for wool (up to `count`). You make shears from iron if you need them."""
    ctx.deps.actions.append(BotAction(type='shear', count=count))
    return 'Started shearing. The bot will report how many, so do not claim it is done.'


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
