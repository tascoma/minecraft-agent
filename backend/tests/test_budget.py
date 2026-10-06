from fastapi.testclient import TestClient
from pydantic_ai.usage import RunUsage

from app.main import app
from app.routes import chat as chat_route
from app.services.budget import Budget, basic_command, prices_for, run_cost


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


def test_cached_tokens_cost_less():
    prices = prices_for('claude-haiku-4-5')
    plain = run_cost(RunUsage(input_tokens=10_000, output_tokens=100), prices)
    cached = run_cost(RunUsage(input_tokens=10_000, cache_read_tokens=9_000, output_tokens=100), prices)
    assert round(plain, 4) == 0.0105
    assert round(cached, 4) == 0.0024


def test_budget_runs_out_and_comes_back_after_the_hour():
    clock = Clock()
    budget = Budget(0.02, 'claude-haiku-4-5', clock=clock)
    budget.record(RunUsage(input_tokens=10_000, output_tokens=100))
    assert not budget.exhausted()
    clock.now = 600
    budget.record(RunUsage(input_tokens=10_000, output_tokens=100))
    assert budget.exhausted()
    assert budget.minutes_until_free() == 50, 'once the first run is an hour old'
    clock.now = 3601
    assert not budget.exhausted()
    assert not Budget(0, 'claude-haiku-4-5', clock=clock).exhausted(), '0 means no limit'


def test_basic_commands_without_claude():
    assert basic_command('stop following me') == 'stay'
    assert basic_command('Stay here!') == 'stay'
    assert basic_command('follow me') == 'follow'
    assert basic_command('come here') == 'come'
    assert basic_command('make a pickaxe') is None


def test_over_budget_chat_skips_the_agent(monkeypatch):
    clock = Clock()
    spent = Budget(0.001, 'claude-haiku-4-5', clock=clock)
    spent.record(RunUsage(input_tokens=10_000))
    monkeypatch.setattr(chat_route, 'budget', spent)
    client = TestClient(app)
    follow = client.post('/chat', json={'username': 'Steve', 'message': 'follow me'}).json()
    assert follow['actions'][0]['type'] == 'follow'
    other = client.post('/chat', json={'username': 'Steve', 'message': 'make a pickaxe'}).json()
    assert 'thinking budget' in other['reply'] and other['actions'] == []

