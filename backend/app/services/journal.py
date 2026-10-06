"""Long-term memory, per world, kept in JSON files so it survives restarts.

- Notes: things the player asked the agent to remember ("I like the base tidy", "the mine is a
  death trap"), saved by the agent with a tool and shown in its instructions on every run.
- Journal: what happened, reported by the bot as it goes (jobs finished, deaths, trips to the
  Nether), so the agent knows how a job turned out and can answer "what did you do today?".
"""

import time
from functools import lru_cache
from pathlib import Path

from pydantic import BaseModel, TypeAdapter

from app.services.files import world_file, write_json

# Keep the newest this many of each; older ones are dropped.
MAX_NOTES = 40
MAX_EVENTS = 300


class Note(BaseModel):
    text: str
    # Who said it, so "I" in a note can be read correctly later.
    by: str
    at: float = 0.0


class Event(BaseModel):
    """Something that happened, as the bot reported it."""

    # 'job', 'death', 'travel', 'join', ...
    kind: str
    text: str
    at: float = 0.0


NOTES = TypeAdapter(list[Note])
EVENTS = TypeAdapter(list[Event])


def words(text: str) -> set[str]:
    return {w.strip('.,!?"\'').lower() for w in text.split() if len(w) > 2}


def ago(at: float, now: float) -> str:
    """'just now', '5 min ago', '3 h ago', '2 days ago'."""
    minutes = int((now - at) // 60)
    if minutes < 1:
        return 'just now'
    if minutes < 60:
        return f'{minutes} min ago'
    if minutes < 48 * 60:
        return f'{minutes // 60} h ago'
    return f'{minutes // (24 * 60)} days ago'


class Journal:
    def __init__(self, notes_path: Path, events_path: Path, clock=time.time) -> None:
        self.notes_path = notes_path
        self.events_path = events_path
        self._clock = clock

    # --- Notes --------------------------------------------------------------
    def notes(self) -> list[Note]:
        return NOTES.validate_json(self.notes_path.read_bytes()) if self.notes_path.exists() else []

    def remember(self, text: str, by: str) -> None:
        notes = [n for n in self.notes() if n.text.lower() != text.lower()]
        notes.append(Note(text=text, by=by, at=self._clock()))
        write_json(self.notes_path, [n.model_dump() for n in notes[-MAX_NOTES:]])

    def forget(self, about: str) -> list[Note]:
        """Drop the notes that best match `about` (sharing the most words with it). Returns them."""
        notes = self.notes()
        wanted = words(about)
        scored = [(len(wanted & words(n.text)), n) for n in notes]
        best = max((s for s, _ in scored), default=0)
        if best == 0:
            return []
        dropped = [n for s, n in scored if s == best]
        write_json(self.notes_path, [n.model_dump() for n in notes if n not in dropped])
        return dropped

    # --- Events -------------------------------------------------------------
    def events(self) -> list[Event]:
        return EVENTS.validate_json(self.events_path.read_bytes()) if self.events_path.exists() else []

    def record(self, event: Event) -> None:
        events = self.events()
        events.append(event.model_copy(update={'at': event.at or self._clock()}))
        write_json(self.events_path, [e.model_dump() for e in events[-MAX_EVENTS:]])

    def recent(self, count: int, within_s: float) -> list[Event]:
        now = self._clock()
        return [e for e in self.events() if now - e.at <= within_s][-count:]

    def search(self, query: str, count: int = 8) -> list[Event]:
        """Events sharing words with `query`, newest first."""
        wanted = words(query)
        return [e for e in reversed(self.events()) if wanted & words(e.text)][:count]

    def ago(self, at: float) -> str:
        return ago(at, self._clock())


@lru_cache
def get_journal(world_id: str | None = None) -> Journal:
    return Journal(world_file(world_id, 'notes.json'), world_file(world_id, 'journal.json'))
