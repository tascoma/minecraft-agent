import logging
from logging.handlers import RotatingFileHandler

from app.core.config import REPO_ROOT

LOG_DIR = REPO_ROOT / 'backend' / 'logs'
LOG_FORMAT = '%(asctime)s %(levelname)s %(name)s: %(message)s'


def setup_logging() -> None:
    """Send `app.*` logs to backend/logs/agent.log (rotated at 5 MB) and the console."""
    LOG_DIR.mkdir(exist_ok=True)
    formatter = logging.Formatter(LOG_FORMAT)

    file_handler = RotatingFileHandler(LOG_DIR / 'agent.log', maxBytes=5_000_000, backupCount=5, encoding='utf-8')
    file_handler.setFormatter(formatter)
    console_handler = logging.StreamHandler()
    console_handler.setFormatter(formatter)

    logger = logging.getLogger('app')
    logger.handlers.clear()
    logger.addHandler(file_handler)
    logger.addHandler(console_handler)
    logger.setLevel(logging.INFO)
