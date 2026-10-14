from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart, ToolReturnPart

from app.agents import agent as agent_module
from app.agents.agent import ChatDeps, agent
from app.main import app
from app.services.commands import COMMANDS, asks_about_spend, exact_command, is_small_talk
from app.services.memory import memory
from pydantic_ai.models.function import FunctionModel

client = TestClient(app)


@pytest.mark.parametrize(
    ('message', 'command'),
    [
        ('stop', 'stay'),
        ('Stop!', 'stay'),
        ('stay here', 'stay'),
        ('wait', 'stay'),
        ('please stop', 'stay'),
        ('follow me', 'follow'),
        ('Follow me, please.', 'follow'),
        ('come', 'come'),
        ('come here!!', 'come'),
        ('COME HERE', 'come'),
    ],
)
def test_exact_commands(message, command):
    assert exact_command(message) == command


@pytest.mark.parametrize(
    'message',
    [
        'stop following and get wood',
        'stop following me',
        'come here and bring wood',
        'follow me to the cave',
        'wait for me at home',
        "don't stop",
        'stay away from the creeper',
        'can you come here?',
        '',
    ],
)
def test_longer_messages_are_not_commands(message):
    assert exact_command(message) is None


@pytest.mark.parametrize('message', ['lol', 'LOL!', 'loool', 'lmao', 'haha', 'ok', 'Ok.', 'thanks!', 'ty', 'nice', '😂', ':)', '👍👍'])
def test_small_talk(message):
    assert is_small_talk(message)


@pytest.mark.parametrize(
    'message', ['?', 'ok get wood', 'thanks for the sword, now get stone', 'nice, build a house', 'what is that', 'yes', 'no', '12']
)
def test_real_messages_are_not_small_talk(message):
    assert not is_small_talk(message)


def agent_must_not_run(messages, info):
    raise AssertionError('the agent should not have been called')


def test_exact_command_skips_the_agent_and_acts():
    with agent.override(model=FunctionModel(agent_must_not_run)):
        stay = client.post('/chat', json={'username': 'Steve', 'message': 'stop'}).json()
        follow = client.post('/chat', json={'username': 'Steve', 'message': 'Follow me please'}).json()
        come = client.post('/chat', json={'username': 'Steve', 'message': 'come here'}).json()
    assert [a['type'] for a in stay['actions']] == ['stay'] and stay['reply']
    assert follow['actions'][0] == {**follow['actions'][0], 'type': 'follow', 'username': 'Steve'}
    assert come['actions'][0]['type'] == 'come' and come['actions'][0]['username'] == 'Steve'


def test_longer_message_with_a_command_in_it_reaches_the_agent():
    calls = []

    def respond(messages, info):
        calls.append(messages)
        return ModelResponse(parts=[TextPart('On it!')])

    with agent.override(model=FunctionModel(respond)):
        client.post('/chat', json={'username': 'Steve', 'message': 'stop following and get wood'})
    assert len(calls) == 1


def test_fast_command_is_remembered_as_a_tool_call_for_the_next_message():
    calls = []

    def respond(messages, info):
        calls.append(messages)
        return ModelResponse(parts=[TextPart('Sure.')])

    with agent.override(model=FunctionModel(respond)):
        client.post('/chat', json={'username': 'Steve', 'message': 'stay'})
        client.post('/chat', json={'username': 'Steve', 'message': 'now get wood'})
    sent = calls[0]
    calls_made = [p for m in sent for p in m.parts if isinstance(p, ToolCallPart)]
    returns = [p for m in sent for p in m.parts if isinstance(p, ToolReturnPart)]
    assert [c.tool_name for c in calls_made] == ['stay_here']
    assert [r.tool_call_id for r in returns] == [c.tool_call_id for c in calls_made]
    assert 'Steve: stay' in repr(sent[0])


def test_small_talk_gets_no_reply_and_no_agent_run():
    with agent.override(model=FunctionModel(agent_must_not_run)):
        response = client.post('/chat', json={'username': 'Steve', 'message': 'lol'}).json()
    assert response['reply'] == '' and response['actions'] == []


def test_ok_after_a_question_reaches_the_agent():
    calls = []

    def respond(messages, info):
        calls.append(messages)
        return ModelResponse(parts=[TextPart('Want me to also craft a sword?' if len(calls) == 1 else 'Great.')])

    with agent.override(model=FunctionModel(respond)):
        client.post('/chat', json={'username': 'Steve', 'message': 'I need a pickaxe'})
        client.post('/chat', json={'username': 'Steve', 'message': 'ok'})
    assert len(calls) == 2, 'the bot asked something, so "ok" is an answer'
    assert memory.asked_question('Steve') is False


def test_fast_command_text_matches_what_the_tools_say():
    deps = ChatDeps(username='Steve')
    ctx = SimpleNamespace(deps=deps)
    tools = {
        'stay_here': agent_module.stay_here,
        'follow_player': agent_module.follow_player,
        'come_here': agent_module.come_here,
    }
    for spec in COMMANDS.values():
        assert tools[spec.tool](ctx) == spec.tool_result.format(username='Steve')


@pytest.mark.parametrize(
    ('message', 'command'),
    [('Claude, stop', 'stay'), ('claude follow me', 'follow'), ('come here, Claude!', 'come'), ('Claude: please come', 'come')],
)
def test_the_bots_name_does_not_stop_a_command_counting(message, command):
    assert exact_command(message, 'Claude') == command
    assert exact_command(message) is None, 'without the name configured it is a longer message'


def test_the_name_alone_or_in_the_middle_is_not_stripped():
    assert exact_command('Claude', 'Claude') is None
    assert exact_command('stop claude following me', 'Claude') is None
    assert is_small_talk('thanks claude', 'Claude')


@pytest.mark.parametrize(
    'message',
    ['how much have you spent?', 'How much did you spend', 'claude, how much have you spent so far?', "what's your budget", 'How much budget is left?'],
)
def test_spend_questions(message):
    assert asks_about_spend(message, 'Claude')


@pytest.mark.parametrize('message', ['how much wood do you have', 'how much have you got in the chest', 'spend the diamonds on a sword', 'what do you cost to run, in detail please explain'])
def test_other_questions_are_not_spend_questions(message):
    assert not asks_about_spend(message, 'Claude')


def test_spend_question_is_answered_from_the_budget_without_the_agent(monkeypatch):
    from pydantic_ai.usage import RunUsage

    from app.routes import chat as chat_route
    from app.services.budget import Budget

    spent = Budget(0.5, 'claude-haiku-5-5')
    spent.record(RunUsage(input_tokens=1_000_000))  # $0.10
    monkeypatch.setattr(chat_route, 'budget', spent)
    with agent.override(model=FunctionModel(agent_must_not_run)):
        response = client.post('/chat', json={'username': 'Steve', 'message': 'how much have you spent?'}).json()
    assert response['reply'] == "I've spent about $0.10 of my $0.50 hourly budget in the last hour."
    assert response['actions'] == []


def test_amounts_keep_their_digits_when_small():
    from app.routes.chat import spent_phrase

    assert [spent_phrase(x) for x in (0, 0.00004, 0.0042, 0.0099, 0.01, 0.1, 0.5)] == [
        'nothing', 'less than $0.0001', 'about $0.0042', 'about $0.0099', 'about $0.01', 'about $0.10', 'about $0.50'
    ]


def test_spend_answer_says_when_the_budget_is_used_up_or_unlimited(monkeypatch):
    from pydantic_ai.usage import RunUsage

    from app.routes import chat as chat_route
    from app.services.budget import Budget

    used_up = Budget(0.05, 'claude-haiku-5-5')
    used_up.record(RunUsage(input_tokens=1_000_000))
    monkeypatch.setattr(chat_route, 'budget', used_up)
    assert 'only follow, stay and come for about' in chat_route.spend_reply()
    monkeypatch.setattr(chat_route, 'budget', Budget(0, 'claude-haiku-5-5'))
    assert 'no limit set' in chat_route.spend_reply()


def test_spend_exchange_is_remembered_so_a_follow_up_makes_sense():
    seen = []

    def respond(messages, info):
        seen.append(messages)
        return ModelResponse(parts=[TextPart('Not much, really.')])

    with agent.override(model=FunctionModel(respond)):
        client.post('/chat', json={'username': 'Steve', 'message': 'how much have you spent?'})
        client.post('/chat', json={'username': 'Steve', 'message': 'is that a lot?'})
    texts = [p.content for m in seen[0] for p in m.parts if hasattr(p, 'content') and isinstance(p.content, str)]
    assert any('hourly budget' in t for t in texts), 'the agent sees what the bot said about spending'
