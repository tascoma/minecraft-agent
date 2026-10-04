import os

# Settings require an API key at import time; tests never call the real model.
os.environ.setdefault('ANTHROPIC_API_KEY', 'test-key')
