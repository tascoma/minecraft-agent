# Optimization plan

How to make the companion cheaper and quicker to answer: fewer Claude calls, fewer model requests per call, fewer tokens per request, and less work in the bot on each chat. Each phase builds on the ones before it.

All five phases are done and merged. The measured results are in each phase's "Result" section and in "Where this ended up" under Phase 5. See [architecture.md](../../architecture.md) for how the pieces fit together (including "What a chat costs"), and the [survival functionality plan](survival-functionality-plan.md) for the format this plan follows.

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

## Phase 1: Don't call Claude when nothing needs thinking ✅

The biggest savings: a call that never happens costs nothing and answers instantly.

| Item | Saves | Where | Status |
|---|---|---|---|
| **Fast path for exact commands.** "stop", "stay", "wait", "follow me", "come here", "come" (the whole message, give or take punctuation and "please") are handled in the route without the agent, every time, not only when over budget. Anything longer goes to the agent as before, so "stop following and get wood" isn't misread. Logged and recorded in memory as an exchange, so a later "ok now get wood" still has context. Record it as a synthetic tool call plus its matching return (e.g. `stay_here`), not as text only, or it undoes the "keep tool calls in history" rule in `memory.py:4-5`. Don't reuse `basic_command`: its substring match (`budget.py:100`) catches "stop following and get wood" | Calls, Latency | `services/commands.py`, `routes/chat.py` | ✅ |
| **Ignore chatter that isn't meant for the bot.** With two or more players online, only messages that mention the bot's name (or reply within ~30 s of the bot speaking to that player) go to the agent. With one player, everything still goes through. Spectators don't count as a player, so the in-game checks' tester doesn't switch the filter on | Calls | `bot/core/chatter.js`, `bot/index.js` | ✅ |
| **Skip trivial small talk.** "lol", "ok", "ty", "nice", emoji-only: answer from a short canned list, or say nothing, with no agent call. Keep the list small and exact-match. Said to nobody, so the bot stays quiet; and not after the bot asked a question ("ok" is then an answer) | Calls | `services/commands.py`, `routes/chat.py` | ✅ |
| **Debounce bursts.** A player who types three lines in two seconds gets one agent run over all three, not three runs. Built as a per-player queue, not a delay: the first line goes straight through, and lines that arrive while it is being answered are joined into one follow-up run, so a single message never waits. A burst of three costs two runs, not one | Calls | `bot/core/chatQueue.js`, `bot/index.js` | ✅ |
| Tests for each rule, including the things that must still reach the agent | n/a | `backend/tests/test_commands.py`, `bot/test/chat.test.js` | ✅ |

**Result** (same 32-message replay, `python3 backend/scripts/token-report.py backend/logs/replay-phase1-*.log`): 7 of 32 messages (22%) no longer run the agent (3 exact commands, 4 small talk). Total cost fell from $0.0126 to $0.0110, and those 7 now answer instantly instead of in about 2 s. The runs that still go to the agent cost the same as before ($0.0004 each).

- The cost saving is small because those messages were already the cheap ones; the gain that matters is latency, and the bot no longer says something for every "lol".
- Not measured by the replay: the chatter filter and the chat queue, which live in the bot. They are covered by `bot/test/chat.test.js`.
- The filter trades convenience for savings: with a friend online, the main player has to say the bot's name ("Claude, get wood") unless the bot just spoke to them.
- One replay miss is model variance, not this phase: "make an iron pickaxe, then a sword, then armor" chose `mine_for` this time and `make_item` six times in the baseline. Re-run before relying on a single result.

## Phase 2: Fewer model requests per run (first item done)

| Item | Saves | Where | Status |
|---|---|---|---|
| **End the run on action tools.** Spike first: make the fire-and-forget action tools (collect, make_item, hunt, build_shelter, go_to, …) end the run, using Pydantic AI output functions, or one `act` output that takes a reply and a list of actions, so the reply is written alongside the call instead of in a second request. Keep several queued jobs in one reply working. Keep lookup tools (`find_item`, `recall`) as normal tools, since their results are needed before answering. This also removes the "empty reply after a tool call" Haiku problem that `FALLBACK_REPLY` works around (check in Phase 0 whether Haiku 5.5 still does this; if not, the spike matters less). Acceptance criteria: text-only replies still work for questions and small talk, and the `SKIP` check (`chat.py:126`) and the string use of `result.output` (`:186`) keep working. If text output isn't allowed, Pydantic AI forces `tool_choice=any`, and a forced choice skips thinking (`profiles/anthropic.py:406`), so measure the behavior change rather than assume it. Built as output tools: see the result below | Requests, Latency | `agents/agent.py`, `routes/chat.py` | ✅ |
| **Put the inventory summary in the status line.** "What do you have?" then needs no `check_inventory` round trip. Cap it (e.g. top 15 stacks plus "and N more") so a full inventory doesn't bloat every request. Measure whether the extra tokens on every message cost more than the requests saved. Judge this after the Phase 3 status move, since the cost depends on where the status sits | Requests vs Tokens | `services/world.py` | 🔲 |
| Same check for a one-line "nearby" digest (hostile mobs within 16, the player's distance) against keeping `nearby_entities` as a tool | Requests vs Tokens | `services/world.py` | 🔲 |
| Count how often each skill is loaded (from Phase 0 logs; grep for the `load_capability` tool name). A skill loaded on most runs that need it could become a line of instructions; one never loaded could go | Requests | `skills/` | 🔲 |

**Result of the first item** (same 32-message replay, run lines in `backend/logs/replay-phase2b-*.log`):

| | Phase 1 | Phase 2 | Phase 2, `EFFORT=low` |
|---|---|---|---|
| Requests per action run (avg) | 2.14 | 1.07 | n/a |
| Latency per action run (avg) | 2.4 s | 1.6 s | n/a |
| Cost per action run (avg) | $0.00050 | $0.00031 | n/a |
| Total for the 32 messages | $0.0110 | $0.0087 | $0.0065 |
| Expected tools called | 30/32 | 30/32 | 30/32 |

- 35 tools that only start something (every one that adds a `BotAction`) are now output tools, collected by the `@action` decorator into `ACTION_TOOLS` and passed to every run as `OUTPUT_TYPES`. The route passes them per run, so `agent.run` without them still works for tests. `end_strategy='exhaustive'` plus `sequential=True` makes several calls in one reply all run, in the order called.
- A mistake an action can't carry out ("no saved place called castle") is a `ModelRetry`: it goes back to the model like a tool result and the model answers in text.
- The reply is the text the model wrote next to the call. With the first instruction wording Haiku 5.5 wrote none for 9 of 15 action runs, so the bot said "On it!". Telling it to ALWAYS begin such a message with one sentence fixed that (every reply in the replay was natural). If it writes none anyway, the bot says what the tool started ("Started gathering 64 coal."), taken from the tool's own result, not a bare "On it!".
- The model no longer sees an action's result before it replies, so "don't claim it's done" now lives in the instructions as well as the tool results. Phase 3's "shorten tool results" item can drop the results' repeated caveat for action tools.
- The run is still allowed to answer in plain text, so `tool_choice` stays `auto` and thinking still runs (88% of runs used it, as before).
- The `UnexpectedModelBehavior` fallback in `routes/chat.py` (actions kept when the model answers a tool result with nothing) can no longer trigger for action tools. It is left in as a cheap safety net.
- The other three items wait for Phase 3: whether adding the inventory or a nearby digest to the status line pays depends on where the status sits.

## Phase 3: Fewer tokens per request ✅

| Item | Saves | Where | Status |
|---|---|---|---|
| **Move the status line out of the system instructions** and into the start of the user message (`[Status] … \n Steve: get wood`). The system prompt and earlier history then stay the same between messages and get cache reads. This also changes `test_agent.py:37`, which asserts the status is in the instructions. Only after this move can the static instructions get their own cache breakpoint (`anthropic_cache_instructions`): today all `@agent.instructions` form one system block ending in the status line (`agent.py:561-596`), so a breakpoint would land after the status `compact()` strips the status block from stored messages so old statuses don't pile up in history. Verify with Phase 0's cache hit rate. Done, with the instructions breakpoint on (see the result below) | Tokens | `agents/agent.py`, `services/world.py`, `services/memory.py`, `routes/chat.py` | ✅ |
| Order the remaining dynamic instructions from least to most often changed (notes → places → chest count → recent events), and move recent events next to the status if it changes as often. Done; recent events stay in the instructions, since they change when a job ends, not on every message | Tokens | `agents/agent.py` | ✅ |
| **Trim tool descriptions.** Cut repeated phrases ("The bot will…" appears in 31 tool *results* and the "do not claim/say" wording in 15; say it once in the instructions instead), and keep examples only where the model gets names wrong. The cache floor is only 512 tokens on Haiku 5.5 (see ground rules). **Skipped:** the tool block is read from the cache at $0.01 per million tokens, so a 20% trim saves about $0.000015 per request, which is not worth the risk of the model picking the wrong tool | Tokens | `agents/agent.py` | ➖ |
| **Merge near-duplicate tools**: `store_items` / `take_items` / `check_chests` / `sort_chests` → one `chests(action, …)`, `villager_trades` / `trade_with_villager` → one, `pillar_up` / `bridge` → one. Only if the replay set shows the model still picks the right one. **Skipped** for the same reason as trimming the descriptions | Tokens | `agents/agent.py` | ➖ |
| Shorten tool results: one short clause each ("Queued.") once the "don't claim it's done" rule lives in the instructions. **Moot:** since Phase 2 the model never sees an action tool's result (the run ends at the call), so shortening them saves no tokens; lookup tools return data the model needs | Tokens | `agents/agent.py` | ➖ |
| Drop `World id` from the status line; the model never needs it | Tokens | `services/world.py` | ✅ |
| History: try 3 exchanges instead of 5, and 150-char tool results instead of 300. Check that follow-ups ("get it", "do that again") still work on the replay set. **Skipped:** the history is cache reads now, so the saving is negligible and the follow-ups ("get it", "do that again") are the thing it could break | Tokens | `services/memory.py` | ➖ |
| Set `max_tokens` so a rambling reply can't run up output tokens; replies are one or two sentences anyway. Haiku 5.5 thinks by default and thinking counts against `max_tokens`, so ~300 could cut off a reply before any text. Size it after measuring thinking, or lower the effort first. Set to 2048: the biggest answer in the replay used about 420 output tokens, and this only stops a runaway | Tokens | `agents/agent.py` | ✅ |
| Try the 1-hour cache TTL for tool definitions (`anthropic_cache_tool_definitions='1h'` is already supported, so no new plumbing). A write costs 2x instead of 1.25x but survives quiet stretches. Worth it only if Phase 0 shows many cache writes after gaps of 5–60 min. Done: in real play (`agent.log`) 5 of 49 runs rewrote the 7k-token tool block after a gap of 7–35 minutes, which an hour-long entry avoids. `budget.py` now prices the one-hour part of cache writes at 2x, from `usage.details` | Tokens | `agents/agent.py`, `services/budget.py` | ✅ |

➖ means decided against, with the reason in the row.

**Result** (replay with the stub state now changing between messages, as a real status line does; run lines in `backend/logs/replay-p3-*.log`):

| | Before | Status moved | + instructions breakpoint | + 1 h tool cache (final) |
|---|---|---|---|---|
| Cache writes per agent run (avg) | 1,348 | 1,341 | 466 | 484 |
| Cache hit rate | 89% | 89% | 96% | 96% |
| Cost per agent run (avg) | $0.0004 | $0.0004 | $0.0003 | $0.0003 |
| Total, 32 messages | $0.0093 | $0.0091 | $0.0065 | $0.0068 |
| Latency per agent run (avg) | 1.8 s | 1.8 s | 1.7 s | 2.2 s |

- Moving the status alone changed almost nothing. The instructions block had no cache breakpoint of its own, so it was rewritten on every fresh conversation whether or not the status was in it. The breakpoint (`anthropic_cache_instructions`) is what cut the writes by about two thirds.
- Latency did not improve and varies run to run (1.7–2.2 s) with the model's own time; take it as flat.
- The replay is mostly fresh conversations, so it shows the instructions and tool layers. The history layer (the moving breakpoint) gains more in real play with longer conversations; read the real rate from `agent.log` after play.
- Kept conversations drop the status line (`memory.compact`), so the stored history differs from what was sent for the latest exchange only; everything older is identical and reads from the cache.
- The one-hour write was not exercised by the replay (the tool block was still cached from an earlier 5-minute run, and a one-hour request can read that). It was verified once the entry had expired: the first message afterwards wrote 8,240 tokens, 7,196 of them (the tool block) at the one-hour rate, and the logged cost matched the 2x price.
- Cheap guardrail for Phase 5: a test that the instructions don't change when only the status does (added: `test_status_leads_the_message_and_stays_out_of_the_instructions`).

## Phase 4: Bot-side performance ✅

No tokens, but it's latency on every chat and CPU while playing. Measure before changing anything.

| Item | Saves | Where | Status |
|---|---|---|---|
| Time `snapshot()`. `nearbyBlocks` runs one `findBlocks` per interesting block type (every `_log`, `_ore`, `_bed`, …), each over a 32-block radius. Log its duration per chat. Done with `bot/core/perf.js`: `snapshot`, `snapshot.blocks` and `snapshot.entities` are timed, every periodic handler is wrapped in `timed`, and the bot logs one `perf:` line every 5 minutes (calls, average, slowest call, share of a core, event loop lag). Each chat also logs its snapshot's size | n/a | `bot/core/perf.js`, `bot/core/state.js`, `bot/index.js` | ✅ |
| If it's slow: one scan over the area, grouping by type, instead of one search per type; or cache the result for a few seconds and reuse it for back-to-back chats. It was slow: see the result. Fixed with grouped searches (6 instead of ~130), which needs no cache | Latency, Bot CPU | `bot/core/state.js` | ✅ |
| Send `nearby_blocks` / `nearby_entities` only when they changed since the last chat, or only the top N, if the request size turns out to matter. **Skipped:** the snapshot is 4.5 KB over localhost, and the backend only turns the blocks and entities into text when the agent calls `look_around` or `nearby_entities` | Latency | `bot/core/state.js`, `schema/chat.py` | ➖ |
| Profile the tick handlers of reflexes that run every tick or every second (creeper scan, combat, survival) with `--cpu-prof` during a long session, and throttle anything hot. Done with the `perf:` lines instead of `--cpu-prof`, which would mostly show Mineflayer and the pathfinder: nothing of ours is hot (see the result), so nothing is throttled | Bot CPU | `bot/reflexes/` | ✅ |

**Result.** Measured in your world on 2026-10-13 and 2026-10-14, bot following the player, a few chats:

| | Share of one core | Average | Slowest |
|---|---|---|---|
| `snapshot.blocks` (per chat) | 0.84% | **1,257 ms** | 1,269 ms |
| `snapshot.entities` | 0.00% | 0.15 ms | 0.2 ms |
| `combat.tick` (10 per second) | 0.33% | 0.34 ms | 1.0 ms |
| `combat.creeper` / `threat` / `arrows` | 0.14% / 0.10% / 0.08% | 0.14 / 0.11 / 0.08 ms | 0.7 ms |
| `alerts.checkPlayer` (1 per second) | 0.05% | 0.52 ms | 14 ms |
| `survival.reflexes` (2 per second) | 0.00% | 0.01 ms | 0.1 ms |
| `travel.entityMoved` (about 300 per second) | 0.01% | 0.00 ms | 0.1 ms |
| `storage.dropOffCheck` | 0.00% | 0.01 ms | 0.0 ms |

- **The only slow thing was the block scan.** `nearbyBlocks` called `findBlocks` once per interesting block type (about 130 searches), each walking every chunk section in range. Every chat froze the bot's event loop for about 1.25 s (loop lag max 1,283 ms), during which it could not walk, fight or eat, and the agent's reply waited on it.
- **The fix** searches common blocks (water, sand, gravel, clay) on their own, logs in one search, and everything else (ores, stems, chests, beds, ...) in another: 6 searches, then counts each type from the results. The per-type cap of 100 and the `more` flag are unchanged, and a crowded common block still cannot hide a rare one.
- **Benchmark** (read-only, as ClaudeTester, 609 loaded chunk columns, 3 rounds): old 754-803 ms, new 162-163 ms, identical output (same types, counts, `more` and distances) every round. About 4.7x faster; the live bot was slower than the benchmark (1,257 ms), and on the live bot after the fix the gap between "heard" and "snapshot" in `bot.log` was 183 ms and 199 ms (it was about 1,250 ms before), about 6x faster.
- **Why not faster:** each search still walks the chunk sections through Mineflayer's `blockAt`. A single pass over the chunk data by state id would be about 10x faster again, but it reaches into prismarine-chunk internals; 160 ms once per chat is not worth that risk.
- **Not measured:** the handlers during a fight (the windows so far had at most a short zombie fight earlier). `combat.tick` includes the fight step, so it will show up in the next `perf:` lines after a fight. The sleep/wake gap (one window showed a 264 s loop stall and a third of the expected ticks) is the laptop sleeping, not the bot.
- I did not run `check:combat` to force a fight: it summons husks next to the bot, which follows you.

## Phase 5: Guardrails ✅

| Item | Saves | Where | Status |
|---|---|---|---|
| A test that fails when the tool definitions grow past a token limit, so growth is a choice (the 4096 floor check is no longer needed on Haiku 5.5). `test_tool_definitions_stay_under_their_size_limit` sends one run to a stub model, collects every tool (the 35 output tools too) and fails above 18,600 characters of JSON, about 8,000 tokens against 7,287 measured today. It works offline; the limit comes from `count_tokens` at 2.32 characters per token | Tokens | `backend/tests/test_agent.py` | ✅ |
| Show spend in game: "how much have you spent?" answers from the budget without the agent (fast path). Also handles "what's your budget" and "how much budget is left". It says what was spent in the last hour, the hourly limit, and for how long the bot only follows, stays and comes if the limit is used up | Calls | `services/commands.py`, `routes/chat.py` | ✅ |
| Update the stale Haiku 4.5 cache-floor comment at `agent.py:48-53`, and the README's cost paragraph and `architecture.md` with the measured per-message cost once phases 1–3 land. The stale comment was replaced in Phase 3; the README and a new "What a chat costs" table in `architecture.md` carry the numbers | n/a | docs | ✅ |

Two fixes found along the way:

- `count-prompt-tokens.py` was written before Phase 2 and only counted the normal tools; it now includes the action tools, which are output tools. The total is unchanged (7,287 tokens, 46 tools), and the script now reports instructions (944 tokens, cached) and a typical status line (96 tokens, not cached) separately.
- Phase 1's fast path missed "Claude, stop": with a friend online the filter requires the bot's name, which made the message longer than the exact command. The name (`MC_USERNAME`, now also read by the backend) is ignored at either end of an exact command, small talk or spend question.

### Where this ended up

The 32-message replay against the real model, from the Phase 0 baseline to the end:

| | Phase 0 baseline | After Phase 5 |
|---|---|---|
| Total cost, 32 messages | $0.0126 | $0.0068 (about 46% less) |
| Messages that run the agent | 32 | 25 (7 are free and instant) |
| Model requests per action run | 2 | 1.07 |
| Latency of an action run | 2.4 s | 1.6 s |
| Cache writes per agent run | 1,408 | 484 |
| Bot freeze on each chat | 1.25 s | 0.19 s |

The total is a conservative comparison: the baseline replay used one fixed state, which made its cache look better than real play, while the later runs moved the state between messages. The cost per message is small to begin with at Haiku 5.5 prices (about two hundredths of a cent per message on average), so the lasting gains are latency and the bot no longer freezing; the savings in dollars are a bonus. The numbers move with the model's own choices (thinking, tool picks), so re-run the replay before trusting a single result.

---

## Testing

- Backend: `cd backend && uv run pytest`. Every new rule (fast path, filters, status placement, history compaction) gets unit tests.
- Bot: `cd bot && npm test`.
- Replay set (Phase 0): run before and after each phase. Compare tokens, requests, $ and latency. Also check that the right tools were called.
- In game: the `check-*.js` scripts after each phase. They run in a real world, so keep them off the player's base and chests.
