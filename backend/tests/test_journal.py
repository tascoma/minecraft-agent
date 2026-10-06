from types import SimpleNamespace

from fastapi.testclient import TestClient

from app.agents.agent import ChatDeps, forget_note, notes, recall, recent_events, remember_note
from app.main import app
from app.services.journal import Event, Journal, ago
from tests.test_world import make_state


class Clock:
    def __init__(self):
        self.now = 1_000_000.0

    def __call__(self):
        return self.now


def journal(tmp_path, clock):
    return Journal(tmp_path / 'notes.json', tmp_path / 'journal.json', clock=clock)


def ctx(tmp_path, clock):
    return SimpleNamespace(deps=ChatDeps(username='Steve', state=make_state(), journal=journal(tmp_path, clock)))


def test_notes_are_kept_shown_and_forgotten(tmp_path):
    c = ctx(tmp_path, Clock())
    remember_note(c, note='Steve likes the base tidy')
    remember_note(c, note='The mine floods when it rains')
    remember_note(c, note='steve likes the base tidy')  # same note again: kept once
    assert notes(c) == 'Things you were asked to remember (newest last):\n- Steve: The mine floods when it rains\n- Steve: steve likes the base tidy'
    assert 'Forgot: The mine floods' in forget_note(c, about='the mine flooding')
    assert 'No note' in forget_note(c, about='dragons')
    assert 'mine' not in notes(c)


def test_recent_events_and_recall(tmp_path):
    clock = Clock()
    c = ctx(tmp_path, clock)
    j = c.deps.journal
    j.record(Event(kind='job', text='getting 20 cobblestone: Got 20 cobblestone.'))
    clock.now += 4 * 3600
    j.record(Event(kind='death', text='died at (10, 64, -3) in the overworld'))
    clock.now += 5 * 60
    shown = recent_events(c)
    assert '5 min ago: died at' in shown and 'cobblestone' not in shown, 'only the last 3 hours'
    assert '4 h ago: getting 20 cobblestone' in recall(c, about='cobblestone')
    assert 'Nothing about' in recall(c, about='diamonds')


def test_ago_reads_naturally():
    assert ago(100, 120) == 'just now'
    assert ago(0, 600) == '10 min ago'
    assert ago(0, 3 * 3600) == '3 h ago'
    assert ago(0, 3 * 86400) == '3 days ago'


def test_bot_reports_events(tmp_path, monkeypatch):
    from app.services import files, journal as journal_module

    monkeypatch.setattr(files, 'get_settings', lambda: SimpleNamespace(data_dir=tmp_path))
    journal_module.get_journal.cache_clear()
    client = TestClient(app)
    assert client.post('/events?world=seed-a', json={'kind': 'job', 'text': 'Built the shelter.'}).status_code == 200
    [event] = journal_module.get_journal('seed-a').events()
    assert event.text == 'Built the shelter.' and event.at > 0
    journal_module.get_journal.cache_clear()
