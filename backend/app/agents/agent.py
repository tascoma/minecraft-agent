from dataclasses import dataclass, field

from pydantic_ai import Agent, RunContext
from pydantic_ai.models.anthropic import AnthropicModel
from pydantic_ai.providers.anthropic import AnthropicProvider
from pydantic_ai.workspaces import LocalWorkspaceBackend
from pydantic_ai_harness.skills import Skills

from app.core.config import REPO_ROOT, get_settings
from app.schema.chat import BotAction

settings = get_settings()


@dataclass
class ChatDeps:
    username: str
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
        'You follow the player around by default. Use your tools when the player asks you to come along or to stay put.'
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
