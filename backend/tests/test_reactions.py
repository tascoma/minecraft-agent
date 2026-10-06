from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from pydantic_ai.models.test import TestModel

from app.agents.agent import agent
from app.main import app
from app.routes import chat as chat_route

FAILED_JOB = {'kind': 'job', 'text': 'getting 20 iron: I only got 3 raw iron.', 'react': True, 'player': 'Steve'}


@pytest.fixture
def client(tmp_path, monkeypatch):
    from app.services import files, journal

    monkeypatch.setattr(files, 'get_settings', lambda: SimpleNamespace(data_dir=tmp_path))
    journal.get_journal.cache_clear()
    monkeypatch.setattr(chat_route, 'last_reaction', float('-inf'))
    yield TestClient(app)
    journal.get_journal.cache_clear()


def react(monkeypatch, on=True):
    monkeypatch.setattr(chat_route, 'settings', SimpleNamespace(react_to_events=on, react_min_gap_s=120))


def test_events_are_only_recorded_when_reactions_are_off(client, monkeypatch):
    react(monkeypatch, on=False)
    with agent.override(model=TestModel(custom_output_text='Want me to try another spot?')):
        assert client.post('/events', json=FAILED_JOB).json()['reply'] == ''


def test_agent_reacts_to_a_failed_job_but_not_twice_in_a_row(client, monkeypatch):
    react(monkeypatch)
    with agent.override(model=TestModel(call_tools=[], custom_output_text='Only 3 iron here. Want me to go mining?')):
        first = client.post('/events', json=FAILED_JOB).json()
        second = client.post('/events', json=FAILED_JOB).json()
    assert first['reply'] == 'Only 3 iron here. Want me to go mining?'
    assert second['reply'] == '', 'at most one reaction every couple of minutes'


def test_skip_means_say_nothing(client, monkeypatch):
    react(monkeypatch)
    with agent.override(model=TestModel(call_tools=[], custom_output_text='SKIP')):
        assert client.post('/events', json=FAILED_JOB).json()['reply'] == ''


def test_routine_events_never_reach_the_agent(client, monkeypatch):
    react(monkeypatch)
    with agent.override(model=TestModel(custom_output_text='should not be said')):
        reply = client.post('/events', json={'kind': 'job', 'text': 'making 4 stick: Made 4 sticks.'}).json()
    assert reply['reply'] == ''
