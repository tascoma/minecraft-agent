# Architecture

How the minecraft-agent is put together: the two processes, how a message flows through them, and the vocabulary we use (agent, tool, skill, reflex, functionality).

For quick definitions of any term, see [glossary.md](glossary.md). Diagrams are Mermaid. They render on GitHub, and in VS Code with a Mermaid preview extension.

---

## 1. The big picture

```mermaid
flowchart TB
    MC["Minecraft Java on your PC<br/>(world open to LAN)"]

    subgraph BOT["bot/ (Node + Mineflayer) on the Mac"]
        conn["Connection<br/>joins as a player, hears chat"]
        reflex["Reflexes<br/>follow, eat, armor, back off, sleep,<br/>fight back, creepers, shield, drop-off"]
        exec["Action executor + jobs<br/>gather, craft, farm, build, store"]
    end

    subgraph BACKEND["backend/ (Python + FastAPI) on the Mac"]
        route["POST /chat<br/>GET /places, /chests"]
        agent["Pydantic AI agent"]
        tools["Tools<br/>movement, lookups, jobs,<br/>combat, farming, building, storage"]
        memory[("Per-world memory<br/>places, chests")]
        skills["Skills<br/>skills/*/SKILL.md"]
    end

    CLAUDE["Claude API<br/>(Haiku 4.5)"]
    logs[("backend/logs/<br/>agent.log, bot.log")]

    MC <-->|"game protocol"| conn
    conn -->|"chat message"| route
    route --> agent
    agent <-->|"tokens"| CLAUDE
    agent --> tools
    tools <--> memory
    agent -.->|"loads on demand"| skills
    route -->|"reply + actions"| exec
    exec --> MC
    reflex --> MC
    conn -.-> logs
    route -.-> logs
```

There are two processes, and they split the work like this:

| | `bot/` (Node) | `backend/` (Python) |
|---|---|---|
| **Job** | The body: be in the world, move, sense, act | The brain: understand chat and decide what to do |
| **Library** | [Mineflayer](https://github.com/PrismarineJS/mineflayer) and its plugins | FastAPI + [Pydantic AI](https://ai.pydantic.dev) |
| **Talks to** | Minecraft server, backend | Claude API, bot (by replying) |
| **Costs tokens?** | Never | Yes, on every agent run |
| **Speed** | Every game tick (50 ms) | Seconds per decision |

**Why two processes?** Mineflayer, the most complete Minecraft bot library, is JavaScript. Pydantic AI, the agent framework, is Python. Keeping them apart also gives a clean rule: anything that must happen fast or often lives in the bot, and anything that needs judgment lives in the backend.

---

## 2. Vocabulary

These words get mixed up easily, so here's what each means in this project.

### Agent

The **agent** is the decision-maker: one `pydantic_ai.Agent` in `backend/app/agents/agent.py`. On each run it gets:

- **Instructions**: who it is (a friendly companion) and how to reply (short, plain text).
- **The message**: `"TScoms23: follow me"`.
- **Deps**: per-request data (`ChatDeps`: who's talking, the bot's state, the world's saved places and chest memory, and a list where tools record actions).
- **Recent conversation**: the player's last 5 exchanges, including the tool calls, forgotten after 10 minutes of quiet (`services/memory.py`). That's what makes "get it" after "there's coal below us" work. Tool calls have to stay in: with the replies alone, the model learns that saying "on my way!" is enough and stops calling tools.
- **Tools and skills** it may use.

It sends all of this to Claude, runs any tools Claude asks for, and repeats until Claude produces a final text reply. One player message is one **agent run**, which may make several model requests.

There is one agent today. More can be added later (for example, a planner agent for long goals), but one is enough until the instructions get crowded.

### Tool

A **tool** is a Python function the agent can choose to call. Claude sees its name, docstring and parameters, and decides whether to use it.

```python
@agent.tool
def stay_here(ctx: RunContext[ChatDeps]) -> str:
    """Stop following and stand still where you are."""
    ctx.deps.actions.append(BotAction(type='stay'))
    return 'Staying here.'
```

In this project, tools come in two kinds:

- **Action tools** change the world. They don't touch Minecraft directly, because the backend can't. They append a `BotAction` that is sent back to the bot in the `/chat` response, and the bot carries it out. Examples: `follow_player`, `stay_here`.
- **Query tools** read the world: `check_inventory`, `look_around`, `nearby_entities`, `where_are_we`, `find_item`. They read the state snapshot the bot sends with each request (formatted by `app/services/world.py`), or for `find_item` the chest memory, so they never call back into the bot. A status line (world, health, food, position, time, weather, tools, current job, what it's fighting and who it's following) is also added to the agent's instructions on every run.

A tool should be **one clear action** with a description precise enough for Claude to know when to use it. Tool definitions are sent on every request, so each new tool adds a few tokens per message.

### Skill

A **skill** is knowledge, not code: a `SKILL.md` file under `skills/` describing *how* to do something multi-step, such as surviving the first night or getting iron gear.

```
skills/
  survive-first-night/
    SKILL.md      ← name + description in frontmatter, then the playbook
```

On each run the agent sees only each skill's **name and one-line description**. When it decides a skill is relevant, it calls `load_capability` (provided by the `Skills` capability from `pydantic-ai-harness`), and the full playbook is added to its context for that run. That keeps per-message token cost low while letting it know a lot.

Skills tell the agent **what order to do things in**; tools are **how it does each step**. A skill can say "make a stone pickaxe, then get iron"; the agent then calls `make_item` and `collect` to make it happen.

### Reflex

A **reflex** is behavior that runs in the bot on its own: no backend call, no Claude, no tokens. It's triggered by game events or timers.

Following the player is a reflex: `mineflayer-pathfinder` keeps the bot within 3 blocks of you every tick. The agent only switches it on or off.

The survival reflexes in `bot/survival.js` are the same kind of thing: eating, putting on armor, backing off from mobs when hurt, getting out of lava, fire and deep water, and sleeping when you sleep. So are the combat reflexes in `bot/combat.js` (fighting whatever hits the bot or you, attacking mobs that come close, backing away from creepers, raising a shield at arrows) and the automatic drop-off of a full inventory in `bot/storage.js`. Combat uses the same reflex slot as survival, so backing off when badly hurt wins over a fight. Two rules keep reflexes from fighting with what you asked for:

- **Your command wins.** Any action from the agent cancels a running reflex (`survival.cancel()`) and the current job (`cancelTask()`).
- **A reflex finishes, then hands back.** While one is driving, the follow logic stays out of the way (`survival.busy()`); when it's done, the bot goes back to following or standing still (`resume()`). If a reflex interrupts a job (say, a fight in the middle of fishing), the job waits, retries the walk that was cut short, and carries on.

Some rules are enforced here in the bot rather than left to the model: it never hits players, villagers, golems or pets (`canAttack` in `combat.js`), never shoots with one of them near the line of fire, never digs or builds by itself within 16 blocks of a saved place, and never breaks blocks a player placed.

Use a reflex when the behavior is:

- **Time-critical**: dodging a creeper can't wait 2 seconds for a model reply.
- **Frequent**: eating, picking up items, following.
- **Obvious**: no judgment needed, so paying for a model call would be waste.

### Functionality

A **functionality** is something the player experiences, such as "the bot follows me" or "the bot gets me iron armor". It isn't a code unit; it's built from the pieces above:

| Functionality | Reflex (bot) | Tool (agent) | Skill |
|---|---|---|---|
| Follows me around | Pathfinder keeps 3 blocks away | `follow_player`, `stay_here` toggle it | — |
| Survives the first night *(today: advice only)* | — | — | `survive-first-night` |
| Stays alive while playing | Eat, wear armor, back off when hurt, sleep when you sleep | `recover_items` after dying | — |
| Gets me 10 logs | Use the right tool, pick up drops, back off if hurt, drop off at base when full | `collect("log", 10)` | — |
| Makes me a stone pickaxe | Eat, back off if hurt | `make_item("stone_pickaxe")`, which gathers and crafts the whole chain | `tool-progression` |
| Keeps me safe | Fight back, defend you, back away from creepers, shield, bow at range | `attack`, `guard_area` | — |
| Feeds us | Eat | `hunt`, `make_item("cooked_beef")`, `harvest_crops`, `plant_crops`, `breed_animals`, `go_fishing` | — |
| Builds a shelter before night | — | `build_shelter`, `light_up_area` | `survive-first-night` |
| Keeps the base tidy | Drop off a full inventory | `store_items`, `take_items`, `sort_chests`, `find_item` | — |
| Gets a full set of iron gear | Eat, fight back, pick up drops | `mine_for`, queued `make_item` calls | `iron-gear` |
| Takes me to the Nether | Follow through the portal | `build_nether_portal`, `enter_portal`, `hunt` "blaze" | `nether` |

The full list is in [survival-functionality-plan.md](survival-functionality-plan.md).

### Capability (Pydantic AI term)

A **capability** is Pydantic AI's way to bundle instructions, tools and hooks and plug them into an agent with `capabilities=[...]`. `Skills(...)` is a capability. When the tool list grows, we'll group related tools (movement, combat, crafting) into capabilities or toolsets so each stays manageable.

### How they relate

```mermaid
flowchart TB
    F["Functionality<br/>what the player experiences"]
    F -->|"built from"| R["Reflexes<br/>bot/, automatic, free"]
    F -->|"built from"| T["Tools<br/>backend/, chosen by agent"]
    F -->|"guided by"| S["Skills<br/>skills/, playbooks"]
    A["Agent"] -->|"calls"| T
    A -->|"loads"| S
    A -->|"turns on/off"| R
    T -->|"BotAction"| E["Bot action executor"]
    E --> W["Minecraft world"]
    R --> W
```

---

## 3. What happens when you chat

```mermaid
sequenceDiagram
    actor P as You (in Minecraft)
    participant B as Bot (Node)
    participant API as Backend /chat
    participant AG as Agent
    participant C as Claude

    P->>B: "stay here for a sec"
    B->>B: log "heard ..."
    B->>API: POST /chat {username, message}
    API->>AG: agent.run(message, deps)
    AG->>C: instructions + message + tool list
    C-->>AG: call stay_here()
    AG->>AG: stay_here appends BotAction(stay)
    AG->>C: tool result "Staying here."
    C-->>AG: "Got it! I'll wait right here."
    AG-->>API: output + deps.actions
    API->>API: log tool calls, reply, tokens
    API-->>B: {reply, actions: [{type: "stay"}]}
    B->>B: runAction(stay) → pathfinder.setGoal(null)
    B->>P: chat "Got it! I'll wait right here."
```

Meanwhile, with no chat at all, the follow reflex keeps running in the bot. That's why following costs nothing.

The bot only reacts to **real player chat** (the `playerChat` packet, with the sender's UUID and the plain message). It ignores server messages, including the `[Steve: Gave 16 [Bread] to Claude]` lines every operator sees when someone runs a command. Mineflayer's own `chat` event matches those too, which would turn every command into a paid agent run.

---

## 4. Where code lives

```
bot/
  index.js                   connection, reconnect, logging, follow reflex, action executor, backend calls
  world.js                   which world this is (seed hash, MC_WORLD, or the server address)
  state.js                   state snapshot sent with each chat
  alerts.js                  chat warnings: low health, nightfall
  movements.js               pathfinder rules: no digging, safe drops, doors and gates, protected areas
  survival.js                reflexes: eat, armor, back off when hurt, escape lava/fire/water, sleep, item recovery
  combat.js                  reflexes: fight back, defend, creepers, shield; attack and guard jobs; who may be hit
  archery.js                 bow maths: aim for arrow drop and moving targets, line of fire
  tasks.js                   the current job (one at a time, cancellable, with progress) and the queue behind it
  gathering.js               collect and give jobs: what to break for an item, protected areas
  crafting.js                make jobs: recipe chains, smelting, placing and picking up workstations
  farming.js                 hunt, harvest, plant, breed, fish and shear jobs
  building.js                place, light, shelter/hut, bridge and pillar jobs; blueprints
  storage.js                 store, take, inspect and sort jobs; chest memory; drop-off reflex
  travel.js                  through portals (and after the player), eye of ender
  trading.js                 villager trades: list and buy
  walk.js                    walking with a time limit, for every walk inside a job or reflex
  test/                      unit tests (npm test), no Minecraft needed
  scripts/                   in-game checks with a second player (npm run check:*)
  patches/                   fixes to npm packages, applied by patch-package on npm install
backend/app/
  main.py                    FastAPI app, sets up logging at startup
  core/config.py             settings from .env (model, API key, ports)
  core/logging.py            writes backend/logs/agent.log
  core/errors.py             turns failures into chat-friendly error messages
  agents/agent.py            the agent, ChatDeps, and its tools
  routes/chat.py             POST /chat: runs the agent, logs, returns reply + actions; GET /places; /chests
  services/world.py          turns the bot's state snapshot into text for the agent
  services/places.py         named places, saved per world to backend/data/worlds/<id>/places.json
  services/chests.py         chest contents, saved per world to backend/data/worlds/<id>/chests.json
  services/journal.py        notes and the journal of what happened, per world (notes.json, journal.json)
  services/budget.py         the spending limit per hour, and the commands handled without Claude past it
  services/files.py          per-world data file paths and safe JSON writes
  services/memory.py         each player's recent exchanges per world, in memory only
  schema/chat.py             ChatRequest, ChatResponse, BotAction, BotState
backend/data/                things the agent remembers between runs, per world (gitignored)
skills/
  <name>/SKILL.md            playbooks the agent loads on demand
backend/logs/
  agent.log                  agent runs: messages, tool calls, replies, tokens
  bot.log                    bot actions: joins, chat, movement, reflexes, jobs and blocks dug, deaths, errors
  bot-console.log            raw bot console output (library warnings)
```

### The bot ↔ backend contract

Chat goes through `POST /chat` (below). Besides that, the bot fetches saved places (`GET /places`) and remembered chests (`GET /chests`) when it joins, reports chests as it opens them (`POST /chests`, `DELETE /chests`), and reports what happens (`POST /events`: jobs finished, deaths, trips) for the journal. None of these call Claude.

```jsonc
// request (bot → backend); state is built by bot/state.js
{ "username": "TScoms23", "message": "stay here",
  "state": { "world_id": "seed-b766a50ffd11a3cb",
             "health": 18, "food": 15, "position": {"x": 0, "y": 64, "z": 0},
             "dimension": "overworld", "time_of_day": 6000, "raining": false, "thundering": false,
             "held_item": null, "inventory": [...], "nearby_blocks": [...], "nearby_entities": [...],
             "player_position": {...}, "player_distance": 4.5,
             "last_death": null,      // or {position, dimension, seconds_ago} for 5 minutes after dying
             "task": null,            // or {description: "getting 20 cobblestone", progress: "12/20"}
             "fighting": null,        // or the mob it's fighting, like "zombie"
             "following": "TScoms23" } }  // or null when staying put

// response (backend → bot)
{ "reply": "Got it!", "actions": [{ "type": "stay", "username": null }],
  "protected_places": [{ "x": -593, "y": 97, "z": -193, "dimension": "overworld" }] }
// action types (fields in the BotAction docstring, schema/chat.py):
//   moving:   follow, stay, come, goto, teleport, recover
//   jobs:     collect, give, make, attack, guard
//   farming:  hunt, harvest, plant, breed, fish, shear
//   building: build, light, place, pillar, bridge
//   storage:  store, take, inspect, sort
//   progress: mine, portal, enter_portal, throw_eye, trades, trade, explore, pickup
```

When something fails, the backend answers with an error status and `{ "error": "Claude is rate limiting me. Try again in a moment." }`. The message is written for the player (`app/core/errors.py`). The bot says it in chat as `Error: ...` and writes the full details to the logs. The bot reports its own failures the same way: backend unreachable or slow, an action that throws, an unexpected crash. Repeats of the same error are muted for 10 seconds.

When adding an action, change both sides together: add the type to `BotAction` in `schema/chat.py` and handle it in `runAction` in `bot/index.js`. The bot logs a warning for any action type it doesn't know.

---

## 5. Adding new behavior: which piece?

| Question | If yes, put it in... |
|---|---|
| Must it react within a second, or run constantly? | A **reflex** in `bot/` |
| Does the player ask for it, or does it need judgment? | A **tool** in the backend, plus an action handler in the bot |
| Is it a multi-step plan or game knowledge? | A **skill** in `skills/` |
| Does it need to know the world state? | Add it to the snapshot in `bot/state.js` and `BotState` in `schema/chat.py` |

Most functionalities need two or three of these. A typical new action:

1. Bot: implement it with Mineflayer (e.g. `gathering.collect({ item, count })`).
2. Schema: add the action type to `BotAction`.
3. Backend: add a tool that appends the action, with a clear docstring.
4. Bot: handle the new type in `runAction`.
5. Optionally, add or update a skill that uses the tool in a larger plan.

---

## 6. Where the architecture needs to grow

The current design works for instant actions like follow and stay. Survival play needs more:

```mermaid
flowchart LR
    subgraph BOT["bot/"]
        Q["Task queue<br/>long actions, cancellable"]
        ST["State snapshot<br/>health, inventory, nearby"]
        EV["Event reporter<br/>task done, attacked, night"]
    end
    subgraph BACKEND["backend/"]
        CH["POST /chat"]
        EVR["POST /events"]
        MEM[("Memory<br/>waypoints, chests, notes")]
    end
    ST -->|"sent with every request"| CH
    EV -->|"rate-limited"| EVR
    CH -->|"actions"| Q
    EVR -->|"actions"| Q
    CH <--> MEM
    EVR <--> MEM
```

1. **Task queue in the bot.** *Done:* one job at a time with progress, cancel and a result in chat, and jobs from the same reply queue behind it (`bot/tasks.js`). The first action of a reply replaces what's running; the rest wait their turn. Every job waits out reflexes and carries on.
2. **State snapshot** ✅. Each request includes health, hunger, position, time, inventory and nearby points of interest, so the agent decides with real information instead of guessing.
3. **Events endpoint.** *Done.* `POST /events` records jobs finished, deaths and trips in the journal, which the agent reads on its next message. The bot marks failed jobs and deaths as worth a reaction; with `REACT_TO_EVENTS=true` the backend then runs the agent on an `[Event]` message (it may reply SKIP), at most every 2 minutes and within the budget, and the reply and actions go back to the bot like a chat reply.
4. **Memory.** Named places and chest contents are done (`services/places.py`, `services/chests.py`); the bot reports a chest each time it opens one (`POST /chests`), loads them on join (`GET /chests`) and reports chests it finds gone (`DELETE /chests`). It also remembers where it last died, in memory only. Notes the player asks it to keep, and a journal of what happened, are in `services/journal.py`; the agent sees the notes and the last few events on every message, and searches older ones with `recall`.
5. **Tool groups.** The agent now has 45 tools, all sent on every request. Grouping them (movement, gathering, crafting, combat, farming, building, storage) into toolsets or capabilities would keep the list readable and could let the agent load groups only when needed, which also saves tokens.

---

## 7. Patched dependencies

Both patches live in `bot/patches/` and are reapplied by `patch-package` on every `npm install`.

`mineflayer-pathfinder` 2.4.5 has door support, but it's off by default and doesn't work properly:

- It only opens fence gates, and treats every door, open or closed, as a wall. `bot/movements.js` fixes this by checking each door's and gate's actual state.
- After opening a gate or door, it stays in "placing a block" mode. If the bot carries dirt or cobblestone, it then throws on every tick.
- When it smooths a finished route, it puts any step that passes through a door or gate on top of the door's thin panel, a jump the bot can't make. The bot then stands still in front of an open door forever.

`bot/patches/mineflayer-pathfinder+2.4.5.patch` fixes all three, and `patch-package` reapplies it on every `npm install`.

`prismarine-physics` 1.11.1, which moves the bot, has a step-up bug: it checks the headroom for a step along what's left of the movement after the collision (usually nothing) instead of the movement the bot wanted. A ceiling just past the step is missed, the full step height (0.6) bumps into it, and the step is refused. In practice the bot stood forever in front of a doorway it had to step up into from a dirt path or farmland (15/16 of a block high), with the wall block above the door overhead. `bot/patches/prismarine-physics+1.11.1.patch` checks along the intended movement, as Minecraft does, and `test/physics.test.js` rebuilds that doorway.

If you upgrade `mineflayer-pathfinder` or `prismarine-physics`, check whether its patch is still needed. `npm install` fails loudly if it no longer applies.

---

## 8. Limits that keep the bot stable

- **One block at a time, 45 seconds each.** A gathering job gives up on a block it can't reach in 45 seconds and tries another, so the pathfinder can't stall a job by re-planning forever.
- **Every walk inside a job or reflex has a time limit** (`bot/walk.js`): the pathfinder never gives up on its own. Going back for items after dying gets 90 seconds, each dropped item 10, a workstation 60. Trips the player asks for ("go to …") have no limit; "stop" ends them.
- **The bot mines blocks itself** (walk, equip, dig, pick up drops for up to 5 seconds) instead of using `mineflayer-collectblock`, which waited forever for a drop it couldn't reach and froze jobs.
- **Path search radius during jobs.** With digging allowed, almost every block is a possible route, and an unbounded path search ran the bot out of memory (4 GB) once. During jobs the pathfinder only searches 80 blocks around the bot; targets are never more than 48 away.
- **Dying cancels the job.** The items are gone and the bot respawns somewhere else.
- **60 steps per make job.** Every gather, craft, smelt and placement counts; a chain that runs away gives up with a message instead of looping.
- **Unreachable blocks are remembered for 5 minutes**, across jobs, so the bot doesn't keep climbing the same half-chopped tree. It also prefers blocks near its own height over logs high in a canopy.
- **The inventory gets a moment to catch up after each craft.** `bot.craft` can return before the server's inventory update arrives; counting too early made the next craft fail.
- **Fights end.** The bot gives up on a target after 30 seconds or once it's 24 blocks away (a guard keeps after anything near its post), and walks back in when knocked back, since the pathfinder doesn't notice being pushed off a goal it already reached.
- **Jobs that pick things up say when the inventory is full,** and gathering takes a full inventory to the base if there's a chest near a saved place.
- **Placing blocks:** the bot builds bottom-up against something solid, steps clear of a block its own body overlaps (the server refuses it otherwise), and holds jump while pillaring (letting go before placing makes the server refuse the block).
- **Hunting leaves breeders.** It skips babies and the last two adults of a kind within 32 blocks (animals only; monsters don't breed).
- **Portals only on purpose.** The pathfinder treats portal blocks as off-limits, so the bot never wanders into one; going through steps in by hand, and lighting a portal is done from in front of the frame.
- **Spending is capped:** `BUDGET_DOLLARS_PER_HOUR` (default $0.50) over a rolling hour, priced from each run's tokens (cache reads at a tenth, writes at 1.25×). Past it the agent isn't called; stay, follow and come are matched by keyword instead.
- **Instructions are ordered for caching:** what rarely changes (notes, chests) comes first and the status line last, so a message reuses as much of the last one's prompt as possible.
- **Mining trips are bounded:** three tries to get down to the ore's height (5 minutes each), then at most six 24-block tunnels.
