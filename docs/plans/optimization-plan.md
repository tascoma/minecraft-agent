# Optimization plan

How to make the companion cheaper and quicker to answer: fewer Claude calls, fewer model requests per call, fewer tokens per request, and less work in the bot on each chat. Each phase builds on the ones before it.

See [architecture.md](../architecture.md) for how the pieces fit together, and the [survival functionality plan](archive/survival-functionality-plan.md) for the format this plan follows.

**How to read the tables:**

- **Saves** says what an item cuts:
  - **Calls**: agent runs that don't need to happen at all.
  - **Requests**: model round trips inside one agent run.
  - **Tokens**: input or output tokens per request, or cache writes turned into cache reads.
  - **Latency**: time from a chat message to the bot's reply.
  - **Bot CPU**: work the Node bot does on its own.
- **Where** is the file the change lives in.
- ✅ is done, 🔲 is not started.

**Ground rules:**

- Measure first. Every item is checked against Phase 0's numbers before and after. If an item doesn't move the numbers, revert it.
- Don't trade away behavior. The bot must still call tools instead of only saying it will. That's why tool calls stay in the conversation history (see `backend/app/services/memory.py`). Each phase ends by running the in-game checks again (`bot/scripts/check-*.js`).
- Watch the cache thresholds. Haiku 4.5 only caches prefixes of 4096+ tokens. The tool definitions (about 5k tokens) clear that on their own today. If trimming tools takes them under 4096, their separate cache breakpoint stops working. In that case, fold them into the instructions breakpoint instead of losing caching.

---

## Where the tokens go today

Each `/chat` runs the Pydantic AI agent (`backend/app/agents/agent.py`) with:

| Part | Size (to be measured) | Changes | Cached |
|---|---|---|---|
| Tool definitions (45 tools) | ~5k tokens | Never | Yes, own breakpoint, 5 min TTL |
| Static instructions + skill list | ~1k | Never | Shares a breakpoint with what follows |
| Notes, chest count, recent events, saved places | Varies | When a job ends or a note or place changes | Same |
| Status line | ~150 | Nearly every message | Same |
| History: last 5 exchanges, tool results cut to 300 chars | ~0.5–3k | Every message | Within a run only |
| The player's message | Small | Every message | No |

What follows from this:

1. **Every player chat is an agent run**, including "lol", "brb" and chat between two players. The only zero-token path is `basic_command`, and it's used only after the budget runs out (`backend/app/services/budget.py`).
2. **An action command takes at least two model requests.** The model calls `collect(...)`, gets "Started gathering…" back, and then writes its reply. Lookup questions work the same way: `check_inventory` returns text built from state the backend already has.
3. **The status line sits in the system instructions.** Because it changes on nearly every message, it invalidates the cache for everything after it, including the history. Across messages, only the tool definitions get cache reads.
4. **When chat is quieter than every 5 minutes, the tool cache expires,** so the next message pays 1.25x to write ~5k tokens again.

---

## Phase 0: Measure 🔲

Nothing else gets judged without this.

| Item | Saves | Where | Status |
|---|---|---|---|
| Log per-run usage already exists (in / cached / cache writes / out / requests / $) | n/a | `routes/chat.py` | ✅ |
| Also log the run's tool names and whether it was chat, event or fallback, as one structured line (JSON), so it can be grepped and summed | n/a | `routes/chat.py` | 🔲 |
| `scripts/token-report.py`: reads the logs and prints, by message kind, the average and p90 input, cached, written and output tokens, requests, $ and latency, plus the cache hit rate | n/a | new | 🔲 |
| Measure each prompt part on its own with Anthropic's `count_tokens` endpoint (tools, static instructions, skill list, a typical status line, a 5-exchange history), and fill in the table above | n/a | new test or script | 🔲 |
| A fixed replay set of ~30 real chat messages (commands, questions, small talk, multi-job requests). Run it against the backend with a stub state and record the numbers. That's the baseline for every later phase | n/a | `backend/tests/` (marked, not run by default) | 🔲 |

## Phase 1: Don't call Claude when nothing needs thinking

The biggest savings: a call that never happens costs nothing and answers instantly.

| Item | Saves | Where | Status |
|---|---|---|---|
| **Fast path for exact commands.** "stop", "stay", "wait", "follow me", "come here", "come" (the whole message, give or take punctuation and "please") are handled in the route without the agent, every time, not only when over budget. Anything longer goes to the agent as before, so "stop following and get wood" isn't misread. Logged and recorded in memory as an exchange, so a later "ok now get wood" still has context | Calls, Latency | `services/budget.py` → its own `services/commands.py`, `routes/chat.py` | 🔲 |
| **Ignore chatter that isn't meant for the bot.** With two or more players online, only messages that mention the bot's name (or reply within ~30 s of the bot speaking to that player) go to the agent. With one player, everything still goes through | Calls | `bot/index.js` | 🔲 |
| **Skip trivial small talk.** "lol", "ok", "ty", "nice", emoji-only: answer from a short canned list, or say nothing, with no agent call. Keep the list small and exact-match | Calls | bot or route | 🔲 |
| **Debounce bursts.** A player who types three lines in two seconds gets one agent run over all three, not three runs | Calls | `bot/index.js` | 🔲 |
| Tests for each rule, including the things that must still reach the agent | n/a | `backend/tests/test_commands.py`, `bot/test/` | 🔲 |

## Phase 2: Fewer model requests per run

| Item | Saves | Where | Status |
|---|---|---|---|
| **End the run on action tools.** Spike first: make the fire-and-forget action tools (collect, make_item, hunt, build_shelter, go_to, …) end the run, using Pydantic AI output functions, or one `act` output that takes a reply and a list of actions, so the reply is written alongside the call instead of in a second request. Keep several queued jobs in one reply working. Keep lookup tools (`find_item`, `recall`) as normal tools, since their results are needed before answering. This also removes the "empty reply after a tool call" Haiku problem that `FALLBACK_REPLY` works around | Requests, Latency | `agents/agent.py`, `routes/chat.py` | 🔲 |
| **Put the inventory summary in the status line.** "What do you have?" then needs no `check_inventory` round trip. Cap it (e.g. top 15 stacks plus "and N more") so a full inventory doesn't bloat every request. Measure whether the extra tokens on every message cost more than the requests saved | Requests vs Tokens | `services/world.py` | 🔲 |
| Same check for a one-line "nearby" digest (hostile mobs within 16, the player's distance) against keeping `nearby_entities` as a tool | Requests vs Tokens | `services/world.py` | 🔲 |
| Count how often each skill is loaded (from Phase 0 logs). A skill loaded on most runs that need it could become a line of instructions; one never loaded could go | Requests | `skills/` | 🔲 |

## Phase 3: Fewer tokens per request

| Item | Saves | Where | Status |
|---|---|---|---|
| **Move the status line out of the system instructions** and into the start of the user message (`[Status] … \n Steve: get wood`). The system prompt and earlier history then stay the same between messages and get cache reads. `compact()` strips the status block from stored messages so old statuses don't pile up in history. Verify with Phase 0's cache hit rate | Tokens | `agents/agent.py`, `services/memory.py` | 🔲 |
| Order the remaining dynamic instructions from least to most often changed (notes → places → chest count → recent events), and move recent events next to the status if it changes as often | Tokens | `agents/agent.py` | 🔲 |
| **Trim tool descriptions.** Cut repeated phrases ("The bot will report how it goes, so do not claim it is done" appears in ~20 tool *results*; say it once in the instructions instead), and keep examples only where the model gets names wrong. Watch the 4096-token cache floor (see ground rules) | Tokens | `agents/agent.py` | 🔲 |
| **Merge near-duplicate tools**: `store_items` / `take_items` / `check_chests` / `sort_chests` → one `chests(action, …)`, `villager_trades` / `trade_with_villager` → one, `pillar_up` / `bridge` → one. Only if the replay set shows the model still picks the right one | Tokens | `agents/agent.py` | 🔲 |
| Shorten tool results: one short clause each ("Queued.") once the "don't claim it's done" rule lives in the instructions | Tokens | `agents/agent.py` | 🔲 |
| Drop `World id` from the status line; the model never needs it | Tokens | `services/world.py` | 🔲 |
| History: try 3 exchanges instead of 5, and 150-char tool results instead of 300. Check that follow-ups ("get it", "do that again") still work on the replay set | Tokens | `services/memory.py` | 🔲 |
| Set `max_tokens` (~300) so a rambling reply can't run up output tokens; replies are one or two sentences anyway | Tokens | `agents/agent.py` | 🔲 |
| Try the 1-hour cache TTL for tool definitions. A write costs 2x instead of 1.25x but survives quiet stretches. Worth it only if Phase 0 shows many cache writes after gaps of 5–60 min | Tokens | `agents/agent.py`, `services/budget.py` (price the 1 h write) | 🔲 |

## Phase 4: Bot-side performance

No tokens, but it's latency on every chat and CPU while playing. Measure before changing anything.

| Item | Saves | Where | Status |
|---|---|---|---|
| Time `snapshot()`. `nearbyBlocks` runs one `findBlocks` per interesting block type (every `_log`, `_ore`, `_bed`, …), each over a 32-block radius. Log its duration per chat | n/a | `bot/core/state.js` | 🔲 |
| If it's slow: one scan over the area, grouping by type, instead of one search per type; or cache the result for a few seconds and reuse it for back-to-back chats | Latency, Bot CPU | `bot/core/state.js` | 🔲 |
| Send `nearby_blocks` / `nearby_entities` only when they changed since the last chat, or only the top N, if the request size turns out to matter | Latency | `bot/core/state.js`, `schema/chat.py` | 🔲 |
| Profile the tick handlers of reflexes that run every tick or every second (creeper scan, combat, survival) with `--cpu-prof` during a long session, and throttle anything hot | Bot CPU | `bot/reflexes/` | 🔲 |

## Phase 5: Guardrails

| Item | Saves | Where | Status |
|---|---|---|---|
| A test that fails when the tool definitions grow past a token limit, or drop under the 4096 cache floor, so growth is a choice | Tokens | `backend/tests/test_agent.py` | 🔲 |
| Show spend in game: "how much have you spent?" answers from the budget without the agent (fast path) | Calls | `services/commands.py` | 🔲 |
| Update the README's cost paragraph and `architecture.md` with the measured per-message cost once phases 1–3 land | n/a | docs | 🔲 |

---

## Testing

- Backend: `cd backend && uv run pytest`. Every new rule (fast path, filters, status placement, history compaction) gets unit tests.
- Bot: `cd bot && npm test`.
- Replay set (Phase 0): run before and after each phase. Compare tokens, requests, $ and latency. Also check that the right tools were called.
- In game: the `check-*.js` scripts after each phase. They run in a real world, so keep them off the player's base and chests.
