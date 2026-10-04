from pydantic_ai import Agent
from pydantic_ai.models.anthropic import AnthropicModel
from pydantic_ai.providers.anthropic import AnthropicProvider
from pydantic_ai.workspaces import LocalWorkspaceBackend
from pydantic_ai_harness.skills import Skills

from app.core.config import REPO_ROOT, get_settings

settings = get_settings()

agent = Agent(
    AnthropicModel(
        settings.model_name,
        provider=AnthropicProvider(api_key=settings.anthropic_api_key.get_secret_value()),
    ),
    instructions=(
        'You are a friendly Minecraft companion who plays alongside the user in their world. '
        'Your replies are sent as in-game chat, so keep them short: one or two sentences, plain text, no Markdown.'
    ),
    # Skills reads SKILL.md files through its own workspace, so the agent gets no file tools.
    capabilities=[Skills(settings.skills_dir, workspace=LocalWorkspaceBackend(REPO_ROOT))],
)
