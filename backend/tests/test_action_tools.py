"""Action tools end the run: the reply is the text written next to the call, in one model request."""
from fastapi.testclient import TestClient
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart, ToolReturnPart
from pydantic_ai.models.function import FunctionModel

from app.agents.agent import ACTION_TOOLS, OUTPUT_TYPES, agent
from app.main import app

client = TestClient(app)


def chat(message, model):
    with agent.override(model=model):
        return client.post('/chat', json={'username': 'Steve', 'message': message}).json()


def test_an_action_call_ends_the_run_with_the_text_written_next_to_it():
    requests = []

    def respond(messages, info):
        requests.append(messages)
        return ModelResponse(parts=[TextPart("I'm on my way!"), ToolCallPart('follow_player', {})])

    response = chat('follow me around', FunctionModel(respond))
    assert len(requests) == 1, 'no second request to write the reply'
    assert response['reply'] == "I'm on my way!"
    assert [a['type'] for a in response['actions']] == ['follow']


def test_a_call_without_text_names_the_job_it_started():
    response = chat('follow me around', FunctionModel(lambda m, i: ModelResponse(parts=[ToolCallPart('follow_player', {})])))
    assert response['reply'] == 'Now following Steve.'
    assert [a['type'] for a in response['actions']] == ['follow']


def test_several_actions_in_one_reply_all_run_in_order():
    def respond(messages, info):
        return ModelResponse(
            parts=[
                TextPart('Pickaxe, then a sword.'),
                ToolCallPart('make_item', {'item': 'iron_pickaxe', 'count': 1}),
                ToolCallPart('make_item', {'item': 'iron_sword', 'count': 1}),
                ToolCallPart('collect', {'item': 'log', 'count': 8}),
            ]
        )

    response = chat('make an iron pickaxe, then a sword, then get logs', FunctionModel(respond))
    assert [(a['type'], a['item']) for a in response['actions']] == [
        ('make', 'iron_pickaxe'),
        ('make', 'iron_sword'),
        ('collect', 'log'),
    ]


def test_a_lookup_comes_first_and_the_action_ends_the_run():
    requests = []

    def respond(messages, info):
        requests.append(messages)
        if len(requests) == 1:
            return ModelResponse(parts=[ToolCallPart('check_inventory', {})])
        return ModelResponse(parts=[TextPart('You have no wood, so I will get some.'), ToolCallPart('collect', {'item': 'log', 'count': 4})])

    response = chat('make a table', FunctionModel(respond))
    assert len(requests) == 2
    assert response['reply'] == 'You have no wood, so I will get some.'
    assert [a['type'] for a in response['actions']] == ['collect']


def test_a_mistake_goes_back_to_the_model_which_answers_in_text():
    requests = []

    def respond(messages, info):
        requests.append(messages)
        if len(requests) == 1:
            return ModelResponse(parts=[ToolCallPart('go_to_place', {'name': 'castle'})])
        return ModelResponse(parts=[TextPart("I don't have a place called castle.")])

    response = chat('go to the castle', FunctionModel(respond))
    assert response['actions'] == []
    assert response['reply'] == "I don't have a place called castle."
    retry = [p for m in requests[1] for p in m.parts if p.part_kind == 'retry-prompt']
    assert 'No saved place called "castle"' in retry[0].content


def test_the_next_message_sees_the_action_call_and_its_result_in_history():
    seen = []

    def respond(messages, info):
        seen.append(messages)
        if len(seen) == 1:
            return ModelResponse(parts=[TextPart('On it.'), ToolCallPart('collect', {'item': 'log', 'count': 4})])
        return ModelResponse(parts=[TextPart('Still working on it.')])

    with agent.override(model=FunctionModel(respond)):
        client.post('/chat', json={'username': 'Steve', 'message': 'get 4 logs'})
        client.post('/chat', json={'username': 'Steve', 'message': 'how is it going?'})
    calls = [p for m in seen[1] for p in m.parts if isinstance(p, ToolCallPart)]
    returns = [p for m in seen[1] for p in m.parts if isinstance(p, ToolReturnPart)]
    assert [c.tool_name for c in calls] == ['collect']
    assert [r.tool_call_id for r in returns] == [c.tool_call_id for c in calls], 'every call has a result'


def test_plain_text_answers_still_work():
    response = chat('hello there', FunctionModel(lambda m, i: ModelResponse(parts=[TextPart('Hi Steve!')])))
    assert response['reply'] == 'Hi Steve!' and response['actions'] == []


def test_skip_is_still_silence_in_chat():
    response = chat('hello there', FunctionModel(lambda m, i: ModelResponse(parts=[TextPart('SKIP')])))
    assert response['reply'] == ''


def test_every_action_tool_is_an_output_tool_and_none_is_also_a_function_tool():
    names = {fn.__name__ for fn in ACTION_TOOLS}
    assert len(names) == len(ACTION_TOOLS) == len(OUTPUT_TYPES) - 1
    function_tools = set(agent._function_toolset.tools)
    assert not names & function_tools, 'a name registered both ways would clash'
    assert {'collect', 'make_item', 'follow_player', 'go_to_place'} <= names
    assert {'check_inventory', 'find_item', 'recall', 'save_place'} <= function_tools


def test_a_call_without_text_says_what_the_tool_started():
    response = chat('get 64 coal', FunctionModel(lambda m, i: ModelResponse(parts=[ToolCallPart('collect', {'item': 'coal', 'count': 64})])))
    assert response['reply'] == 'Started gathering 64 coal.', 'not the part meant for the model'
