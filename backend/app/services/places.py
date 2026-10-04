"""Named places the player has asked the bot to remember, kept in a JSON file so they survive restarts."""

import hashlib
import json
import re
from functools import lru_cache
from pathlib import Path

from pydantic import BaseModel, TypeAdapter

from app.core.config import get_settings
from app.schema.chat import ProtectedSpot


class Place(BaseModel):
    name: str
    x: int
    y: int
    z: int
    dimension: str


PLACES = TypeAdapter(dict[str, Place])


def normalize(name: str) -> str:
    """Names match regardless of case, spacing and a leading "the", so "The Mine" finds "mine"."""
    name = ' '.join(name.lower().split())
    return name.removeprefix('the ')


class PlaceStore:
    def __init__(self, path: Path) -> None:
        self.path = path

    def all(self) -> list[Place]:
        if not self.path.exists():
            return []
        return list(PLACES.validate_json(self.path.read_bytes()).values())

    def get(self, name: str) -> Place | None:
        return next((p for p in self.all() if normalize(p.name) == normalize(name)), None)

    def save(self, place: Place) -> None:
        places = {normalize(p.name): p for p in self.all()}
        places[normalize(place.name)] = place
        self._write(places)

    def remove(self, name: str) -> bool:
        places = {normalize(p.name): p for p in self.all()}
        if places.pop(normalize(name), None) is None:
            return False
        self._write(places)
        return True

    def _write(self, places: dict[str, Place]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Write to a temporary file first so a crash mid-write can't corrupt the saved places.
        tmp = self.path.with_suffix('.tmp')
        tmp.write_text(json.dumps({k: p.model_dump() for k, p in places.items()}, indent=2))
        tmp.replace(self.path)


def protected_spots(store: PlaceStore) -> list[ProtectedSpot]:
    """Every saved place, as the zones the bot keeps clear of digging and building."""
    return [ProtectedSpot(x=p.x, y=p.y, z=p.z, dimension=p.dimension) for p in store.all()]


def world_dir_name(world_id: str) -> str:
    """A safe folder name for a world id, which can hold characters like ':' or '/'."""
    slug = re.sub(r'[^A-Za-z0-9._-]+', '_', world_id).strip('._')[:40]
    if slug == world_id:
        return slug
    # Different ids can share a slug ("a:b" and "a/b"); the hash keeps their folders apart.
    return f'{slug}-{hashlib.sha1(world_id.encode()).hexdigest()[:8]}'.lstrip('-')


@lru_cache
def get_place_store(world_id: str | None = None) -> PlaceStore:
    """The places for one world. Without a world id (an older bot) it is the original shared file."""
    data_dir = get_settings().data_dir
    if world_id is None:
        return PlaceStore(data_dir / 'places.json')
    return PlaceStore(data_dir / 'worlds' / world_dir_name(world_id) / 'places.json')
