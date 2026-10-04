from app.schema.chat import BotState
from app.services import world


def make_state(**overrides) -> BotState:
    data = {
        'health': 17.5,
        'food': 14,
        'position': {'x': 10, 'y': 64, 'z': -3},
        'dimension': 'overworld',
        'time_of_day': 6000,
        'raining': False,
        'thundering': False,
        'held_item': 'stone_pickaxe',
    }
    return BotState.model_validate(data | overrides)


def test_status_line():
    status = world.describe_status(make_state())
    assert status == (
        'Your status: health 17.5/20 (healthy), food 14/20 (a bit hungry, not healing), at (10, 64, -3) in the Overworld, '
        'day, about 6 min until night, clear, holding stone_pickaxe.'
    )


def test_time_phases():
    assert world.describe_time(0) == 'day, about 11 min until night'
    assert world.describe_time(12500) == 'sunset, night is about to start'
    assert world.describe_time(18000) == 'night, about 4 min until morning'
    assert world.describe_time(23500) == 'sunrise'


def test_inventory_adds_up_stacks():
    state = make_state(inventory=[
        {'name': 'cobblestone', 'count': 64},
        {'name': 'oak_log', 'count': 3},
        {'name': 'cobblestone', 'count': 10},
    ])
    assert world.describe_inventory(state) == 'Inventory: 74 cobblestone, 3 oak_log.'
    assert world.describe_inventory(make_state()) == 'Inventory is empty.'


def test_blocks_and_entities():
    state = make_state(
        nearby_blocks=[
            {'name': 'iron_ore', 'count': 4, 'nearest': {'x': 12, 'y': 60, 'z': -1}, 'distance': 4.9},
            {'name': 'water', 'count': 100, 'more': True, 'nearest': {'x': 9, 'y': 63, 'z': -3}, 'distance': 6},
        ],
        nearby_entities=[
            {'name': 'zombie', 'kind': 'hostile', 'distance': 25.2, 'position': {'x': 15, 'y': 44, 'z': 2}},
            {'name': 'bread', 'kind': 'item', 'count': 2, 'distance': 3, 'position': {'x': 9, 'y': 64, 'z': -1}},
        ],
    )
    assert world.describe_blocks(state) == (
        'Nearby blocks:\n'
        'iron_ore x4, nearest 4.9 blocks away at (12, 60, -1), 4 blocks below you\n'
        'water x100+, nearest 6 blocks away at (9, 63, -3)'
    )
    assert world.describe_entities(state).splitlines()[1:] == [
        'zombie (hostile), 25.2 blocks away at (15, 44, 2), 20 blocks below you',
        '2 bread (item), 3 blocks away at (9, 64, -1)',
    ]


def test_low_health_and_food_are_flagged():
    status = world.describe_status(make_state(health=3.3, food=0))
    assert 'health 3.3/20 (badly hurt)' in status
    assert 'food 0/20 (starving)' in status


def test_location_with_and_without_player():
    seen = make_state(player_position={'x': 20, 'y': 64, 'z': -3}, player_distance=10)
    assert world.describe_location(seen, 'Steve') == (
        'You are at (10, 64, -3) in the Overworld. Steve is at (20, 64, -3), 10 blocks from you.'
    )
    assert 'out of sight' in world.describe_location(make_state(), 'Steve')
