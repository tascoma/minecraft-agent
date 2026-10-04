from types import SimpleNamespace

import pytest

from app.agents.agent import (
    ChatDeps,
    come_here,
    forget_place,
    go_to,
    go_to_place,
    recover_items,
    save_place,
    saved_places,
    stay_here,
    teleport_to_player,
)
from app.schema.chat import BotAction
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
