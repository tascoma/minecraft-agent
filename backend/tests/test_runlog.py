import json
import logging

from fastapi.testclient import TestClient
from pydantic_ai.messages import ModelResponse, TextPart, ThinkingPart, ToolCallPart
from pydantic_ai.usage import RunUsage

from app.main import app
from app.routes import chat as chat_route
from app.services.budget import Budget
from app.services.runlog import log_run


def run_records(caplog) -> list[dict]:
    return [json.loads(r.getMessage().removeprefix('run ')) for r in caplog.records if r.name == 'app.run']


def test_a_run_line_has_usage_tools_and_thinking(caplog):
    caplog.set_level(logging.INFO, logger='app.run')
    messages = [
        ModelResponse(
            parts=[
                ThinkingPart(content='hmm'),
                ToolCallPart(tool_name='collect', args={'item': 'coal'}),
                TextPart(content='On it'),
            ]
        )
    ]
    usage = RunUsage(input_tokens=100, cache_read_tokens=60, cache_write_tokens=10, output_tokens=20, requests=2)
    log_run('chat', username='Steve', model='m', effort='low', seconds=1.234, usage=usage, cost=0.0001, messages=messages)
    [record] = run_records(caplog)
    assert record['kind'] == 'chat' and record['effort'] == 'low' and record['seconds'] == 1.23
    assert (record['input'], record['cached'], record['cache_writes'], record['output'], record['requests']) == (100, 60, 10, 20, 2)
    assert record['tools'] == ['collect']
    assert (record['thinking_parts'], record['thinking_chars']) == (1, 3)


def test_over_budget_chats_are_logged_too(caplog, monkeypatch):
    caplog.set_level(logging.INFO, logger='app.run')
    spent = Budget(0.001, 'claude-haiku-5-5')
    spent.record(RunUsage(input_tokens=1_000_000))
    monkeypatch.setattr(chat_route, 'budget', spent)
    TestClient(app).post('/chat', json={'username': 'Steve', 'message': 'make a pickaxe'})
    [record] = run_records(caplog)
    assert record['kind'] == 'over_budget' and record['requests'] == 0


def test_token_report_sums_run_lines(tmp_path):
    import importlib.util
    from pathlib import Path

    spec = importlib.util.spec_from_file_location('token_report', Path(__file__).parents[2] / 'scripts' / 'token-report.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    record = {'kind': 'chat', 'user': 'S', 'model': 'm', 'effort': None, 'seconds': 2.0, 'input': 1000, 'cached': 800,
              'cache_writes': 0, 'output': 50, 'requests': 2, 'cost': 0.001, 'tools': ['collect'],
              'thinking_parts': 0, 'thinking_chars': 0}
    log = tmp_path / 'agent.log'
    log.write_text(
        f'2026-10-13 18:45:43,529 INFO app.run: run {json.dumps(record)}\n'
        '2026-10-13 18:45:44,000 INFO app.routes.chat: something else\n'
    )
    runs = module.read_runs([log])
    assert len(runs) == 1
    text = module.report(runs)
    assert 'chat' in text and '80%' in text and 'collect 1' in text
