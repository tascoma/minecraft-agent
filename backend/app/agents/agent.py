from dataclasses import dataclass, field

from pydantic_ai import Agent, RunContext
from pydantic_ai.models.anthropic import AnthropicModel
from pydantic_ai.providers.anthropic import AnthropicProvider
from pydantic_ai.workspaces import LocalWorkspaceBackend
from pydantic_ai_harness.skills import Skills

from app.core.config import REPO_ROOT, get_settings
from app.schema.chat import BotAction, BotState
from app.services import world

settings = get_settings()


@dataclass
class ChatDeps:
    username: str
    # None when the bot didn't send its state (e.g. an older bot or a test request).
    state: BotState | None = None
    actions: list[BotAction] = field(default_factory=list)


agent = Agent(
    AnthropicModel(
        settings.model_name,
        provider=AnthropicProvider(api_key=settings.anthropic_api_key.get_secret_value()),
    ),
    deps_type=ChatDeps,
    instructions=(
        'You are a friendly Minecraft companion who plays alongside the user in their world. '
        'Your replies are sent as in-game chat, so keep them short: one or two sentences, plain text, no Markdown. '
        'You follow the player around by default. Use your tools when the player asks you to come along or to stay put. '
        'Use your lookup tools to check your inventory and surroundings before answering questions about them; never guess.'
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
    """Stop following and stand still where you are."""
    ctx.deps.actions.append(BotAction(type='stay'))
    return 'Staying here.'


NO_STATE = "You can't sense the world right now."


@agent.instructions
def status(ctx: RunContext[ChatDeps]) -> str:
    """Health, hunger, position, time and weather, so every reply can take them into account."""
    return world.describe_status(ctx.deps.state) if ctx.deps.state else NO_STATE


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
