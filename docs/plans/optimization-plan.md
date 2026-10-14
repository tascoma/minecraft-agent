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
- Cache thresholds are much looser on Haiku 5.5. Haiku 4.5 only cached prefixes of 4096+ tokens; Haiku 5.5's minimum is 512 (confirm against the prompt caching docs). Trimming the tool definitions (~7k tokens) can't take them under the floor in any realistic case, so the old "fold the tools into the instructions breakpoint" fallback is no longer needed. It also means the static instructions could get their own breakpoint if that turns out to help.
- Haiku 5.5 is priced at $0.10 / $0.50 per million tokens (up to 100k-token prompts), a tenth of Haiku 4.5. Savings in dollars are ten times smaller than this plan first assumed, so Phase 0 matters more: some items may no longer be worth their complexity. Latency and behavior are now the stronger reasons for most items.
- Haiku 5.5 runs adaptive thinking by default, at `medium` effort. Thinking tokens bill as output and add latency. Include this in the Phase 0 numbers, and try a lower effort for chat. Set it with `AnthropicModelSettings(anthropic_effort='low')`, not Pydantic AI's unified `thinking=` setting: the installed pydantic-ai (2.54.0) doesn't list `claude-haiku-5-5` in its model profiles, so `thinking='low'` would send old-style budget thinking and `thinking=False` would send nothing. `anthropic_effort` passes straight through to `output_config.effort`. Pin pydantic-ai in `backend/pyproject.toml` for the Phase 0 baseline (it currently allows `>=2.54.0`), so an upgrade can't quietly change how thinking is handled.

---

## Where the tokens go today

Each `/chat` runs the Pydantic AI agent (`backend/app/agents/agent.py`) with:

| Part | Size (to be measured) | Changes | Cached |
|---|---|---|---|
| Tool definitions (46 tools: 45 `@agent.tool`s plus the Skills capability's `load_capability`) | ~7.3k tokens (measured) | Never | Yes, own breakpoint, 5 min TTL |
| Static instructions + skill list | ~0.85k (measured) | Never | Shares a breakpoint with what follows |
| Notes, chest count, recent events, saved places | Varies | When a job ends or a note or place changes | Same |
| Status line | ~150 | Nearly every message | Same |
| History: last 5 exchanges, tool results cut to 300 chars | ~0.5–3k | Every message | Within a run only |
| The player's message | Small | Every message | No |

What follows from this:

1. **Every player chat is an agent run**, including "lol", "brb" and chat between two players. The only zero-token path is `basic_command`, and it's used only after the budget runs out (`backend/app/services/budget.py`).
2. **An action command takes at least two model requests.** The model calls `collect(...)`, gets "Started gathering…" back, and then writes its reply. Lookup questions work the same way: `check_inventory` returns text built from state the backend already has.
3. **The status line sits in the system instructions.** Because it changes on nearly every message, it invalidates the cache for everything after it, including the history. Across messages, only the tool definitions get cache reads.
4. **When chat is quieter than every 5 minutes, the tool cache expires,** so the next message pays 1.25x to write ~7k tokens again.

---

## Phase 0: Measure ✅

Nothing else gets judged without this. Baseline numbers are at the end of this phase.

| Item | Saves | Where | Status |
|---|---|---|---|
| Log per-run usage already exists (in / cached / cache writes / out / requests / $) | n/a | `routes/chat.py` | ✅ |
| Also log the run's tool names and its kind as one structured line (JSON), so it can be grepped and summed. Write the line on every path, not only success: today the empty-reply fallback (`routes/chat.py:148-161`) and the over-budget path (`:132-134`) log no usage or latency. Kinds: `chat`, `event`, `fallback`, `error`, `over_budget` | n/a | `routes/chat.py`, `services/runlog.py` | ✅ |
| Log thinking separately: `RunUsage.output_tokens` lumps thinking and reply text together, so also log the number of each run's `ThinkingPart`s (the text is empty by default, so there is no length to count). Run the replay set at both `medium` and `low` effort | n/a | `services/runlog.py` | ✅ |
| Pin pydantic-ai and set effort through `AnthropicModelSettings(anthropic_effort=…)` (see ground rules) | n/a | `pyproject.toml`, `core/config.py` (`EFFORT`), `agents/agent.py` | ✅ |
| `backend/scripts/token-report.py`: reads the logs and prints, by message kind, the average and p90 input, cached, written and output tokens, requests, $ and latency, plus the cache hit rate and the share of runs that used thinking | n/a | `backend/scripts/token-report.py` | ✅ |
| Measure each prompt part on its own with Anthropic's `count_tokens` endpoint (tools, instructions, a typical status line), and fill in the table above. History isn't counted separately; read it off the run logs | n/a | `backend/scripts/count-prompt-tokens.py` | ✅ |
| A fixed replay set of 32 chat messages (commands, questions, small talk, multi-job requests, follow-ups). `backend/scripts/replay.py` runs it against the real agent with a stub state and a temporary data dir, writes the run lines to `backend/logs/replay-<label>-<time>.log`, and prints the tools called against the ones expected. It's a script, not a pytest test: it spends real money, and the test suite's fake API key would get in the way. That's the baseline for every later phase | n/a | `backend/scripts/replay.py`, `backend/scripts/replay-messages.json` | ✅ |

**Baseline** (2026-10-13, claude-haiku-5-5, stub state, 32 messages; `python3 backend/scripts/token-report.py backend/logs/replay-*.log`):

| | Default effort (medium) | `EFFORT=low` |
|---|---|---|
| Input tokens per run (avg / p90) | 15.1k / 16.7k | 14.8k / 16.7k |
| Output tokens per run (avg / p90) | 158 / 245 | 143 / 221 |
| Cost per run (avg) | $0.0004 | $0.0002 |
| Latency (avg / p90) | 2.1 s / 2.8 s | 1.9 s / 2.6 s |
| Requests per run | 2 (p90 2) | 2 (p90 2) |
| Runs that used thinking | 69% | 53% |
| Cache hit rate | 91% | 99% |
| Expected tools called | 27/32 before loosening the checks, 31/32 after | 31/32 |

The cache hit rate here is inflated: the replay sends 32 messages back to back with the same stub state, and the low run started within 5 minutes of the first, so it read the first run's cache. Take the real rate from `agent.log` after real play.

Prompt parts (`backend/scripts/count-prompt-tokens.py`): tool definitions 7.3k tokens (46 tools, more than the ~5k estimated), instructions 0.84k with no bot state, 0.92k with a typical state (0.085k of that is state-dependent).

What the baseline says:

- A run is about $0.0004 at default effort. At 100 chats an hour that is 4 cents, well under the 50-cent hourly budget, so cost is not the main reason to optimize; latency and behavior are.
- Every run, small talk included, makes two model requests and sends ~15k input tokens. The tool definitions are about half of that. Phase 1 (skip the agent) and Phase 2 (one request) therefore matter more than trimming tokens.
- `EFFORT=low` cut cost per run in half and was a little quicker, with the same tool choices. Worth making the default once the in-game checks pass.
- The one real miss is chatter meant for another player ("hey Alex, did you see that creeper?"): the bot looks around and answers. That is what Phase 1's "ignore chatter" item fixes.
- Questions the status line or notes already answer ("how are you doing?") are answered without a tool, which is fine; those checks now accept it.

## Phase 1: Don't call Claude when nothing needs thinking

The biggest savings: a call that never happens costs nothing and answers instantly.

| Item | Saves | Where | Status |
|---|---|---|---|
| **Fast path for exact commands.** "stop", "stay", "wait", "follow me", "come here", "come" (the whole message, give or take punctuation and "please") are handled in the route without the agent, every time, not only when over budget. Anything longer goes to the agent as before, so "stop following and get wood" isn't misread. Logged and recorded in memory as an exchange, so a later "ok now get wood" still has context. Record it as a synthetic tool call plus its matching return (e.g. `stay_here`), not as text only, or it undoes the "keep tool calls in history" rule in `memory.py:4-5`. Don't reuse `basic_command`: its substring match (`budget.py:100`) catches "stop following and get wood" | Calls, Latency | `services/budget.py` → its own `services/commands.py`, `routes/chat.py` | 🔲 |
| **Ignore chatter that isn't meant for the bot.** With two or more players online, only messages that mention the bot's name (or reply within ~30 s of the bot speaking to that player) go to the agent. With one player, everything still goes through | Calls | `bot/index.js` | 🔲 |
| **Skip trivial small talk.** "lol", "ok", "ty", "nice", emoji-only: answer from a short canned list, or say nothing, with no agent call. Keep the list small and exact-match | Calls | bot or route | 🔲 |
| **Debounce bursts.** A player who types three lines in two seconds gets one agent run over all three, not three runs | Calls | `bot/index.js` | 🔲 |
| Tests for each rule, including the things that must still reach the agent | n/a | `backend/tests/test_commands.py`, `bot/test/` | 🔲 |

## Phase 2: Fewer model requests per run

| Item | Saves | Where | Status |
|---|---|---|---|
| **End the run on action tools.** Spike first: make the fire-and-forget action tools (collect, make_item, hunt, build_shelter, go_to, …) end the run, using Pydantic AI output functions, or one `act` output that takes a reply and a list of actions, so the reply is written alongside the call instead of in a second request. Keep several queued jobs in one reply working. Keep lookup tools (`find_item`, `recall`) as normal tools, since their results are needed before answering. This also removes the "empty reply after a tool call" Haiku problem that `FALLBACK_REPLY` works around (check in Phase 0 whether Haiku 5.5 still does this; if not, the spike matters less). Acceptance criteria: text-only replies still work for questions and small talk, and the `SKIP` check (`chat.py:126`) and the string use of `result.output` (`:186`) keep working. If text output isn't allowed, Pydantic AI forces `tool_choice=any`, and a forced choice skips thinking (`profiles/anthropic.py:406`), so measure the behavior change rather than assume it | Requests, Latency | `agents/agent.py`, `routes/chat.py` | 🔲 |
| **Put the inventory summary in the status line.** "What do you have?" then needs no `check_inventory` round trip. Cap it (e.g. top 15 stacks plus "and N more") so a full inventory doesn't bloat every request. Measure whether the extra tokens on every message cost more than the requests saved. Judge this after the Phase 3 status move, since the cost depends on where the status sits | Requests vs Tokens | `services/world.py` | 🔲 |
| Same check for a one-line "nearby" digest (hostile mobs within 16, the player's distance) against keeping `nearby_entities` as a tool | Requests vs Tokens | `services/world.py` | 🔲 |
| Count how often each skill is loaded (from Phase 0 logs; grep for the `load_capability` tool name). A skill loaded on most runs that need it could become a line of instructions; one never loaded could go | Requests | `skills/` | 🔲 |

## Phase 3: Fewer tokens per request

| Item | Saves | Where | Status |
|---|---|---|---|
| **Move the status line out of the system instructions** and into the start of the user message (`[Status] … \n Steve: get wood`). The system prompt and earlier history then stay the same between messages and get cache reads. This also changes `test_agent.py:37`, which asserts the status is in the instructions. Only after this move can the static instructions get their own cache breakpoint (`anthropic_cache_instructions`): today all `@agent.instructions` form one system block ending in the status line (`agent.py:561-596`), so a breakpoint would land after the status `compact()` strips the status block from stored messages so old statuses don't pile up in history. Verify with Phase 0's cache hit rate | Tokens | `agents/agent.py`, `services/memory.py` | 🔲 |
| Order the remaining dynamic instructions from least to most often changed (notes → places → chest count → recent events), and move recent events next to the status if it changes as often | Tokens | `agents/agent.py` | 🔲 |
| **Trim tool descriptions.** Cut repeated phrases ("The bot will…" appears in 31 tool *results* and the "do not claim/say" wording in 15; say it once in the instructions instead), and keep examples only where the model gets names wrong. The cache floor is only 512 tokens on Haiku 5.5 (see ground rules) | Tokens | `agents/agent.py` | 🔲 |
| **Merge near-duplicate tools**: `store_items` / `take_items` / `check_chests` / `sort_chests` → one `chests(action, …)`, `villager_trades` / `trade_with_villager` → one, `pillar_up` / `bridge` → one. Only if the replay set shows the model still picks the right one | Tokens | `agents/agent.py` | 🔲 |
| Shorten tool results: one short clause each ("Queued.") once the "don't claim it's done" rule lives in the instructions | Tokens | `agents/agent.py` | 🔲 |
| Drop `World id` from the status line; the model never needs it | Tokens | `services/world.py` | 🔲 |
| History: try 3 exchanges instead of 5, and 150-char tool results instead of 300. Check that follow-ups ("get it", "do that again") still work on the replay set | Tokens | `services/memory.py` | 🔲 |
| Set `max_tokens` so a rambling reply can't run up output tokens; replies are one or two sentences anyway. Haiku 5.5 thinks by default and thinking counts against `max_tokens`, so ~300 could cut off a reply before any text. Size it after measuring thinking, or lower the effort first | Tokens | `agents/agent.py` | 🔲 |
| Try the 1-hour cache TTL for tool definitions (`anthropic_cache_tool_definitions='1h'` is already supported, so no new plumbing). A write costs 2x instead of 1.25x but survives quiet stretches. Worth it only if Phase 0 shows many cache writes after gaps of 5–60 min | Tokens | `agents/agent.py`, `services/budget.py` (price the 1 h write) | 🔲 |

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
| A test that fails when the tool definitions grow past a token limit, so growth is a choice (the 4096 floor check is no longer needed on Haiku 5.5) | Tokens | `backend/tests/test_agent.py` | 🔲 |
| Show spend in game: "how much have you spent?" answers from the budget without the agent (fast path) | Calls | `services/commands.py` | 🔲 |
| Update the stale Haiku 4.5 cache-floor comment at `agent.py:48-53`, and the README's cost paragraph and `architecture.md` with the measured per-message cost once phases 1–3 land | n/a | docs | 🔲 |

---

## Testing

- Backend: `cd backend && uv run pytest`. Every new rule (fast path, filters, status placement, history compaction) gets unit tests.
- Bot: `cd bot && npm test`.
- Replay set (Phase 0): run before and after each phase. Compare tokens, requests, $ and latency. Also check that the right tools were called.
- In game: the `check-*.js` scripts after each phase. They run in a real world, so keep them off the player's base and chests.
