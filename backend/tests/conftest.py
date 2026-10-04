import os
import tempfile

# Settings require an API key at import time; tests never call the real model.
os.environ.setdefault('ANTHROPIC_API_KEY', 'test-key')
# Keep saved places from tests out of the real backend/data/.
os.environ['DATA_DIR'] = tempfile.mkdtemp(prefix='minecraft-agent-test-')

import pytest  # noqa: E402

from app.services.memory import memory  # noqa: E402


@pytest.fixture(autouse=True)
def fresh_conversation_memory():
    """Each test starts with no remembered conversations."""
    memory._conversations.clear()
