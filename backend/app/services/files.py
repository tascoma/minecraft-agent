"""Where the backend keeps what it remembers (backend/data/), and writing those JSON files safely."""

import hashlib
import json
import re
from pathlib import Path
from typing import Any

from app.core.config import get_settings


def world_dir_name(world_id: str) -> str:
    """A safe folder name for a world id, which can hold characters like ':' or '/'."""
    slug = re.sub(r'[^A-Za-z0-9._-]+', '_', world_id).strip('._')[:40]
    if slug == world_id:
        return slug
    # Different ids can share a slug ("a:b" and "a/b"); the hash keeps their folders apart.
    return f'{slug}-{hashlib.sha1(world_id.encode()).hexdigest()[:8]}'.lstrip('-')


def world_file(world_id: str | None, name: str) -> Path:
    """A world's data file, e.g. backend/data/worlds/<id>/places.json. Without a world id (an older
    bot), the shared file backend/data/<name>."""
    data_dir = get_settings().data_dir
    if world_id is None:
        return data_dir / name
    return data_dir / 'worlds' / world_dir_name(world_id) / name


def write_json(path: Path, data: Any) -> None:
    """Write `data` as JSON, via a temporary file so a crash mid-write can't corrupt the file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(path)
