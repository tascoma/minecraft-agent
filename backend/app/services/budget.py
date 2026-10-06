"""A spending limit per hour, so idle chatter (or a runaway loop) can't run up the Claude bill.

Each agent run's token usage is priced and added to a rolling one-hour window. Once the window's
spend reaches the budget, the chat route stops calling Claude until it drops back under, and
handles only the basic commands itself. In memory only: a restart starts a fresh hour.
"""

import time
from collections import deque
from dataclasses import dataclass

from pydantic_ai.usage import RunUsage

HOUR = 3600.0


@dataclass(frozen=True)
class Prices:
    """US dollars per million tokens."""

    input: float
    output: float

    @property
    def cache_read(self) -> float:
        return self.input * 0.1

    @property
    def cache_write(self) -> float:
        # Five-minute cache writes, the only kind the agent uses.
        return self.input * 1.25


# By a fragment of the model name. Anything else is priced like the default model, Haiku 4.5.
PRICES = {
    'haiku-4-5': Prices(input=1.0, output=5.0),
    'sonnet-5': Prices(input=2.0, output=10.0),
    'opus-5': Prices(input=4.0, output=20.0),
}


def prices_for(model_name: str) -> Prices:
    return next((p for fragment, p in PRICES.items() if fragment in model_name), PRICES['haiku-4-5'])


def run_cost(usage: RunUsage, prices: Prices) -> float:
    """What an agent run cost, in dollars. `input_tokens` includes the cached ones."""
    uncached = usage.input_tokens - usage.cache_read_tokens - usage.cache_write_tokens
    return (
        uncached * prices.input
        + usage.cache_read_tokens * prices.cache_read
        + usage.cache_write_tokens * prices.cache_write
        + usage.output_tokens * prices.output
    ) / 1_000_000


class Budget:
    def __init__(self, dollars_per_hour: float, model_name: str, clock=time.monotonic) -> None:
        # 0 or less turns the limit off.
        self.dollars_per_hour = dollars_per_hour
        self.prices = prices_for(model_name)
        self._clock = clock
        self._spent: deque[tuple[float, float]] = deque()

    def _trim(self) -> None:
        while self._spent and self._clock() - self._spent[0][0] > HOUR:
            self._spent.popleft()

    def record(self, usage: RunUsage) -> float:
        """Add a run's cost; returns it."""
        cost = run_cost(usage, self.prices)
        self._spent.append((self._clock(), cost))
        return cost

    def spent(self) -> float:
        """Dollars spent in the last hour."""
        self._trim()
        return sum(c for _, c in self._spent)

    def exhausted(self) -> bool:
        return self.dollars_per_hour > 0 and self.spent() >= self.dollars_per_hour

    def minutes_until_free(self) -> int:
        """Roughly how long until the hour's spend drops back under the budget."""
        self._trim()
        total = self.spent()
        for at, cost in self._spent:
            total -= cost
            if total < self.dollars_per_hour:
                return max(1, round((at + HOUR - self._clock()) / 60))
        return 0


def basic_command(message: str) -> str | None:
    """The handful of commands handled without Claude when the budget is used up: 'stay', 'follow'
    or 'come', or None."""
    text = f' {message.lower().strip()} '
    if any(w in text for w in (' stop', ' stay', ' wait', ' halt')):
        return 'stay'
    if ' follow' in text:
        return 'follow'
    if ' come' in text or ' here ' in text.replace('!', ' ').replace('.', ' '):
        return 'come'
    return None
