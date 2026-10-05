"""What's in each chest the bot has opened, per world, kept in a JSON file so it survives restarts.

The bot sends a chest's contents every time it opens one, so this is as fresh as the bot's last visit;
players can change a chest in between.
"""

import json
import time
from functools import lru_cache
from pathlib import Path

from pydantic import BaseModel, TypeAdapter

from app.core.config import get_settings
from app.schema.chat import Position
from app.services.places import world_dir_name


class Chest(BaseModel):
    x: int
    y: int
    z: int
    dimension: str
    # Item name -> total count.
    items: dict[str, int] = {}
    # Unix time of the bot's last look inside.
    seen_at: float = 0.0

    @property
    def key(self) -> str:
        return f'{self.dimension}:{self.x},{self.y},{self.z}'


CHESTS = TypeAdapter(dict[str, Chest])


def item_matches(name: str, wanted: str) -> bool:
    """"iron" finds iron_ingot and raw_iron; "oak log" finds oak_log; "planks" any planks."""
    wanted = wanted.lower().strip().replace(' ', '_').removeprefix('minecraft:')
    return name == wanted or wanted in name.split('_') or name.startswith(f'{wanted}_') or name.endswith(f'_{wanted}')


class ChestStore:
    def __init__(self, path: Path) -> None:
        self.path = path

    def all(self) -> list[Chest]:
        if not self.path.exists():
            return []
        return list(CHESTS.validate_json(self.path.read_bytes()).values())

    def save(self, chest: Chest) -> None:
        chests = {c.key: c for c in self.all()}
        chests[chest.key] = chest.model_copy(update={'seen_at': chest.seen_at or time.time()})
        self._write(chests)

    def remove(self, x: int, y: int, z: int, dimension: str) -> None:
        chests = {c.key: c for c in self.all()}
        if chests.pop(f'{dimension}:{x},{y},{z}', None) is not None:
            self._write(chests)

    def _write(self, chests: dict[str, Chest]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Write to a temporary file first so a crash mid-write can't corrupt the record.
        tmp = self.path.with_suffix('.tmp')
        tmp.write_text(json.dumps({k: c.model_dump() for k, c in chests.items()}, indent=2))
        tmp.replace(self.path)

    def find(self, item: str) -> list[tuple[Chest, dict[str, int]]]:
        """Chests holding something matching `item`, with the matching items, most first."""
        found = []
        for chest in self.all():
            matching = {name: n for name, n in chest.items.items() if item_matches(name, item)}
            if matching:
                found.append((chest, matching))
        return sorted(found, key=lambda f: -sum(f[1].values()))


def distance(chest: Chest, pos: Position) -> float:
    return ((chest.x - pos.x) ** 2 + (chest.y - pos.y) ** 2 + (chest.z - pos.z) ** 2) ** 0.5


@lru_cache
def get_chest_store(world_id: str | None = None) -> ChestStore:
    """The chests of one world; without a world id (an older bot), one shared file."""
    data_dir = get_settings().data_dir
    if world_id is None:
        return ChestStore(data_dir / 'chests.json')
    return ChestStore(data_dir / 'worlds' / world_dir_name(world_id) / 'chests.json')
