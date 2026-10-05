from types import SimpleNamespace

from fastapi.testclient import TestClient

from app.agents.agent import ChatDeps, check_chests, find_item, sort_chests, store_items, take_items
from app.main import app
from app.schema.chat import BotAction
from app.services import chests as chests_module
from app.services.chests import Chest, ChestStore, item_matches
from app.services.places import Place, PlaceStore
from tests.test_world import make_state


def ctx(tmp_path, **state):
    places = PlaceStore(tmp_path / 'places.json')
    places.save(Place(name='home', x=1, y=64, z=2, dimension='overworld'))
    deps = ChatDeps(username='Steve', state=make_state(**state), places=places, chests=ChestStore(tmp_path / 'chests.json'))
    return SimpleNamespace(deps=deps)


def test_chest_store_keeps_the_latest_look(tmp_path):
    store = ChestStore(tmp_path / 'chests.json')
    store.save(Chest(x=1, y=64, z=2, dimension='overworld', items={'cobblestone': 64}))
    store.save(Chest(x=1, y=64, z=2, dimension='overworld', items={'iron_ingot': 5}))
    store.save(Chest(x=9, y=64, z=9, dimension='overworld', items={'raw_iron': 20}))
    [first, second] = ChestStore(tmp_path / 'chests.json').all()
    assert first.items == {'iron_ingot': 5}, 'same spot replaces the old contents'
    assert first.seen_at > 0
    assert [c.x for c, _ in store.find('iron')] == [9, 1], 'most first'


def test_item_names_match_the_way_players_say_them():
    assert item_matches('iron_ingot', 'iron')
    assert item_matches('raw_iron', 'iron')
    assert item_matches('oak_log', 'oak log')
    assert item_matches('spruce_planks', 'planks')
    assert not item_matches('cobblestone', 'stone')


def test_find_item_answers_from_memory(tmp_path):
    c = ctx(tmp_path)
    assert 'not looked in any chests' in find_item(c, item='iron')
    c.deps.chests.save(Chest(x=10, y=64, z=-3, dimension='overworld', items={'iron_ingot': 12, 'cobblestone': 30}))
    answer = find_item(c, item='iron')
    assert '12 iron_ingot' in answer and '(10, 64, -3)' in answer and '0 blocks away' in answer
    assert 'No diamond' in find_item(c, item='diamond')


def test_storage_tools_queue_actions(tmp_path):
    c = ctx(tmp_path)
    store_items(c)
    store_items(c, item='cobblestone', count=32, place='home')
    take_items(c, item='iron', count=10)
    check_chests(c, place='home')
    sort_chests(c)
    assert 'No saved place' in take_items(c, item='iron', place='castle')
    assert c.deps.actions == [
        BotAction(type='store', item='everything'),
        BotAction(type='store', item='cobblestone', count=32, x=1, y=64, z=2, label='home'),
        BotAction(type='take', item='iron', count=10),
        BotAction(type='inspect', x=1, y=64, z=2, label='home'),
        BotAction(type='sort'),
    ]


def test_bot_reports_and_fetches_chests(tmp_path, monkeypatch):
    monkeypatch.setattr(chests_module, 'get_settings', lambda: SimpleNamespace(data_dir=tmp_path))
    chests_module.get_chest_store.cache_clear()
    client = TestClient(app)
    chest = {'x': 1, 'y': 64, 'z': 2, 'dimension': 'overworld', 'items': {'bread': 3}}
    assert client.post('/chests?world=seed-a', json=chest).status_code == 200
    assert client.get('/chests?world=seed-a').json()[0]['items'] == {'bread': 3}
    assert client.get('/chests?world=seed-b').json() == []
    assert client.delete('/chests?world=seed-a&x=1&y=64&z=2&dimension=overworld').status_code == 200
    assert client.get('/chests?world=seed-a').json() == []
    chests_module.get_chest_store.cache_clear()


def test_progression_tools_queue_actions(tmp_path):
    from app.agents.agent import (
        build_nether_portal, enter_portal, mine_for, throw_ender_eye, trade_with_villager, villager_trades,
    )

    c = ctx(tmp_path)
    mine_for(c, ore='diamond', count=3)
    build_nether_portal(c)
    build_nether_portal(c, place='home')
    enter_portal(c)
    throw_ender_eye(c)
    villager_trades(c)
    trade_with_villager(c, item='bread', count=6)
    assert c.deps.actions == [
        BotAction(type='mine', item='diamond', count=3),
        BotAction(type='portal', username='Steve'),
        BotAction(type='portal', username='Steve', x=1, y=64, z=2, label='home'),
        BotAction(type='enter_portal'),
        BotAction(type='throw_eye'),
        BotAction(type='trades'),
        BotAction(type='trade', item='bread', count=6),
    ]
