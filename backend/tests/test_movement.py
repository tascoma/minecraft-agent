from types import SimpleNamespace

import pytest

from app.agents.agent import (
    ChatDeps,
    collect,
    make_item,
    come_here,
    forget_place,
    give_items,
    go_to,
    go_to_place,
    recover_items,
    save_place,
    saved_places,
    stay_here,
    teleport_to_player,
)
from app.schema.chat import BotAction, ProtectedSpot
from app.services.places import protected_spots
from app.services.places import Place, PlaceStore
from tests.test_world import make_state


@pytest.fixture
def store(tmp_path):
    return PlaceStore(tmp_path / 'places.json')


def ctx(store, **state_overrides):
    """Tools only use ctx.deps, so a stand-in context is enough to call them directly."""
    return SimpleNamespace(deps=ChatDeps(username='Steve', state=make_state(**state_overrides), places=store))


def test_place_store_round_trip(store, tmp_path):
    store.save(Place(name='Home', x=1, y=64, z=2, dimension='overworld'))
    store.save(Place(name='The Mine', x=5, y=12, z=9, dimension='overworld'))
    # Names match regardless of case and a leading "the"; a new store reads the same file.
    reloaded = PlaceStore(tmp_path / 'places.json')
    assert reloaded.get('home').x == 1
    assert reloaded.get('mine').name == 'The Mine'
    store.save(Place(name='home', x=7, y=70, z=8, dimension='overworld'))
    assert [p.x for p in reloaded.all()] == [7, 5]
    assert reloaded.remove('HOME')
    assert not reloaded.remove('home')
    assert reloaded.get('home') is None


def test_movement_tools_queue_actions(store):
    c = ctx(store)
    stay_here(c)
    come_here(c)
    go_to(c, x=10, z=-20)
    go_to(c, x=10, z=-20, y=70)
    teleport_to_player(c)
    recover_items(c)
    assert c.deps.actions == [
        BotAction(type='stay'),
        BotAction(type='come', username='Steve'),
        BotAction(type='goto', x=10, z=-20),
        BotAction(type='goto', x=10, y=70, z=-20),
        BotAction(type='teleport', username='Steve'),
        BotAction(type='recover'),
    ]


def test_save_place_uses_player_position_when_visible(store):
    c = ctx(store, player_position={'x': 20, 'y': 65, 'z': 30}, player_distance=5)
    assert 'their position' in save_place(c, 'home')
    assert store.get('home') == Place(name='home', x=20, y=65, z=30, dimension='overworld')

    # Can't see the player: fall back to the bot's own position.
    save_place(ctx(store), 'camp')
    assert (store.get('camp').x, store.get('camp').z) == (10, -3)


def test_go_to_place(store):
    store.save(Place(name='home', x=20, y=65, z=30, dimension='overworld'))
    store.save(Place(name='fortress', x=1, y=70, z=1, dimension='the_nether'))
    c = ctx(store)

    go_to_place(c, 'Home')
    assert c.deps.actions == [BotAction(type='goto', x=20, y=65, z=30, label='home')]
    assert go_to_place(c, 'fortress') == 'fortress is in the Nether, but you are in the Overworld.'
    assert go_to_place(c, 'castle') == 'No saved place called "castle". Saved places: home, fortress.'
    assert len(c.deps.actions) == 1

    assert forget_place(c, 'home') == 'Forgot "home".'
    assert forget_place(c, 'home') == 'No saved place called "home".'


def test_saved_places_in_instructions(store):
    c = ctx(store)
    assert saved_places(c) == 'No saved places yet.'
    store.save(Place(name='home', x=10, y=64, z=27, dimension='overworld'))
    store.save(Place(name='fortress', x=1, y=70, z=1, dimension='the_nether'))
    assert saved_places(c) == (
        'Saved places: home at (10, 64, 27), 30 blocks away; fortress at (1, 70, 1) in the Nether.'
    )


def test_collect_and_give_actions(store):
    c = ctx(store)
    collect(c, item='cobblestone', count=20)
    give_items(c, item='coal')
    give_items(c, item='oak_log', count=5)
    assert c.deps.actions == [
        BotAction(type='collect', item='cobblestone', count=20),
        BotAction(type='give', username='Steve', item='coal'),
        BotAction(type='give', username='Steve', item='oak_log', count=5),
    ]


def test_saved_places_become_protected_spots(store):
    store.save(Place(name='home', x=20, y=65, z=30, dimension='overworld'))
    assert protected_spots(store) == [ProtectedSpot(x=20, y=65, z=30, dimension='overworld')]


def test_make_action(store):
    c = ctx(store)
    make_item(c, item='stone_pickaxe')
    make_item(c, item='torch', count=8)
    assert c.deps.actions == [
        BotAction(type='make', item='stone_pickaxe', count=1),
        BotAction(type='make', item='torch', count=8),
    ]


def test_places_are_kept_per_world(tmp_path, monkeypatch):
    from app.services import places

    monkeypatch.setattr(places, 'get_settings', lambda: SimpleNamespace(data_dir=tmp_path))
    places.get_place_store.cache_clear()
    places.get_place_store('seed-a').save(Place(name='home', x=1, y=64, z=1, dimension='overworld'))
    assert places.get_place_store('seed-b').all() == []
    assert [p.name for p in places.get_place_store('seed-a').all()] == ['home']
    # Ids with odd characters get a safe folder, and different ids never share one.
    assert places.world_dir_name('localhost:25565') != places.world_dir_name('localhost/25565')
    assert '/' not in places.world_dir_name('../x/y')
    places.get_place_store.cache_clear()


def test_attack_queues_an_action(store):
    from app.agents.agent import attack

    c = ctx(store)
    attack(c, target='zombie')
    attack(c)
    assert c.deps.actions == [BotAction(type='attack', target='zombie'), BotAction(type='attack')]


def test_guard_a_saved_place_or_where_the_player_is(store):
    from app.agents.agent import guard_area

    store.save(Place(name='home', x=1, y=64, z=2, dimension='overworld'))
    c = ctx(store, player_position={'x': 5, 'y': 70, 'z': 6})
    guard_area(c, place='Home')
    guard_area(c)
    assert 'No saved place' in guard_area(c, place='castle')
    assert c.deps.actions == [
        BotAction(type='guard', x=1, y=64, z=2, label='home'),
        BotAction(type='guard', x=5, y=70, z=6),
    ]


def test_farming_tools_queue_actions(store):
    from app.agents.agent import breed_animals, go_fishing, harvest_crops, hunt, plant_crops, shear_sheep

    c = ctx(store)
    hunt(c, animal='cow', count=3)
    harvest_crops(c)
    plant_crops(c, crop='carrots', count=8)
    breed_animals(c, animal='sheep')
    go_fishing(c, count=2)
    shear_sheep(c)
    assert c.deps.actions == [
        BotAction(type='hunt', target='cow', count=3),
        BotAction(type='harvest'),
        BotAction(type='plant', target='carrots', count=8),
        BotAction(type='breed', target='sheep'),
        BotAction(type='fish', count=2),
        BotAction(type='shear', count=64),
    ]


def test_building_tools_queue_actions(store):
    from app.agents.agent import bridge, build_shelter, light_up_area, pillar_up, place_block

    store.save(Place(name='home', x=1, y=64, z=2, dimension='overworld'))
    c = ctx(store)
    build_shelter(c)
    build_shelter(c, kind='small house', material='wood', place='home')
    place_block(c, item='chest', place='home')
    place_block(c, item='torch')
    light_up_area(c, radius=12)
    pillar_up(c, height=3)
    bridge(c, length=8, direction='east')
    assert 'No saved place' in place_block(c, item='chest', place='castle')
    assert c.deps.actions == [
        BotAction(type='build', target='shelter', username='Steve', x=10, y=64, z=-3),
        BotAction(type='build', target='hut', item='wood', username='Steve', x=1, y=64, z=2, label='home'),
        BotAction(type='place', item='chest', username='Steve', x=1, y=64, z=2, label='home'),
        BotAction(type='place', item='torch', username='Steve'),
        BotAction(type='light', count=12),
        BotAction(type='pillar', count=3),
        BotAction(type='bridge', target='east', count=8, username='Steve'),
    ]
