"""Turns the bot's state snapshot into short text the agent can read."""

from collections import Counter

from app.schema.chat import BotState, Position
from app.services.places import Place

# Ticks per real second, and when hostile mobs start and stop spawning.
TICKS_PER_SECOND = 20
NIGHT_START = 13000
NIGHT_END = 23000


def describe_time(time_of_day: int) -> str:
    if time_of_day < 12000:
        minutes = (NIGHT_START - time_of_day) / TICKS_PER_SECOND / 60
        return f'day, about {minutes:.0f} min until night'
    if time_of_day < NIGHT_START:
        return 'sunset, night is about to start'
    if time_of_day < NIGHT_END:
        minutes = (NIGHT_END - time_of_day) / TICKS_PER_SECOND / 60
        return f'night, about {minutes:.0f} min until morning'
    return 'sunrise'


def describe_weather(state: BotState) -> str:
    if state.thundering:
        return 'thunderstorm'
    return 'raining' if state.raining else 'clear'


def describe_dimension(dimension: str) -> str:
    """'the_nether' -> 'the Nether', so sentences read "in the Nether" rather than "in the the_nether"."""
    name = dimension.removeprefix('the_').replace('_', ' ').title()
    return f'the {name}'


def format_position(p: Position) -> str:
    return f'({p.x}, {p.y}, {p.z})'


def describe_height(target: Position, me: Position) -> str:
    """How far above or below the bot something is, so the agent can tell what's underground."""
    dy = target.y - me.y
    if abs(dy) < 3:
        return ''
    return f', {abs(dy)} blocks {"above" if dy > 0 else "below"} you'


def describe_health(health: float) -> str:
    if health <= 6:
        return 'badly hurt'
    if health <= 12:
        return 'hurt'
    return 'healthy'


def describe_food(food: int) -> str:
    # Natural healing needs 18+ food; at 0 you take starvation damage.
    if food == 0:
        return 'starving'
    if food <= 6:
        return 'very hungry, not healing'
    if food < 18:
        return 'a bit hungry, not healing'
    return 'well fed'


def describe_status(state: BotState) -> str:
    """One line with the essentials, added to the agent's instructions on every run."""
    held = state.held_item or 'nothing'
    return (
        f'Your status: health {state.health:g}/20 ({describe_health(state.health)}), '
        f'food {state.food}/20 ({describe_food(state.food)}), '
        f'at {format_position(state.position)} in {describe_dimension(state.dimension)}, '
        f'{describe_time(state.time_of_day)}, {describe_weather(state)}, holding {held}.'
    )


def describe_inventory(state: BotState) -> str:
    # The bot sends one entry per slot; add up stacks of the same item.
    totals: Counter[str] = Counter()
    for item in state.inventory:
        totals[item.name] += item.count
    if not totals:
        return 'Inventory is empty.'
    return 'Inventory: ' + ', '.join(f'{count} {name}' for name, count in totals.most_common()) + '.'


def describe_blocks(state: BotState) -> str:
    if not state.nearby_blocks:
        return 'Nothing notable nearby (no ores, trees, water, lava or workstations within 32 blocks).'
    lines = [
        f'{b.name} x{b.count}{"+" if b.more else ""}, nearest {b.distance:g} blocks away '
        f'at {format_position(b.nearest)}{describe_height(b.nearest, state.position)}'
        for b in state.nearby_blocks
    ]
    return 'Nearby blocks:\n' + '\n'.join(lines)


def describe_entities(state: BotState) -> str:
    if not state.nearby_entities:
        return 'No creatures, players or dropped items within 32 blocks.'
    lines = []
    for e in state.nearby_entities:
        name = f'{e.count} {e.name}' if e.count else e.name
        lines.append(
            f'{name} ({e.kind}), {e.distance:g} blocks away at {format_position(e.position)}'
            f'{describe_height(e.position, state.position)}'
        )
    return 'Nearby (things far below you are usually in caves, out of sight):\n' + '\n'.join(lines)


def describe_location(state: BotState, username: str) -> str:
    here = f'You are at {format_position(state.position)} in {describe_dimension(state.dimension)}.'
    if state.player_position is None or state.player_distance is None:
        return f"{here} {username} is out of sight, so they are probably far away."
    return (
        f'{here} {username} is at {format_position(state.player_position)}, '
        f'{state.player_distance:g} blocks from you.'
    )


def describe_places(places: list[Place], state: BotState | None) -> str:
    if not places:
        return 'No saved places yet.'
    parts = []
    for p in places:
        text = f'{p.name} at ({p.x}, {p.y}, {p.z})'
        if state and p.dimension == state.dimension:
            # Straight-line distance, rounded; the walk is usually longer.
            here = state.position
            distance = ((p.x - here.x) ** 2 + (p.y - here.y) ** 2 + (p.z - here.z) ** 2) ** 0.5
            text += f', {distance:.0f} blocks away'
        else:
            text += f' in {describe_dimension(p.dimension)}'
        parts.append(text)
    return 'Saved places: ' + '; '.join(parts) + '.'
