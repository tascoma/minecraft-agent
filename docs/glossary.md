# Glossary

Terms used in this project and its docs, grouped by area. Within each group, terms are in alphabetical order.

See [architecture.md](architecture.md) for how the pieces fit together, and [survival-functionality-plan.md](survival-functionality-plan.md) for what's planned.

**Contents:** [Project concepts](#project-concepts) · [AI and the agent](#ai-and-the-agent) · [Bot and Mineflayer](#bot-and-mineflayer) · [Backend and tooling](#backend-and-tooling) · [Minecraft](#minecraft)

---

## Project concepts

The words this project uses for its own building blocks.

**Action**: Something the agent wants the bot to do in the world, like follow or stay. The agent's tool records it as a `BotAction`; the backend sends it to the bot in the `/chat` response; the bot's action executor carries it out.

**Action executor**: The part of `bot/index.js` (`runAction` and `dispatch`) that takes actions from the backend and hands each to the job or command that performs it. The first action of a reply replaces what's running; the rest queue. Logs a warning for any action type it doesn't recognize.

**Action tool**: A tool that changes the world (`follow_player`, `stay_here`, `come_here`, `go_to`, `go_to_place`, `teleport_to_player`, `recover_items`, `collect`, `give_items`, `make_item`, `attack`, `guard_area`, `hunt`, `harvest_crops`, `plant_crops`, `breed_animals`, `go_fishing`, `shear_sheep`, `build_shelter`, `place_block`, `light_up_area`, `pillar_up`, `bridge`, `store_items`, `take_items`, `check_chests`, `sort_chests`, `mine_for`, `build_nether_portal`, `enter_portal`, `throw_ender_eye`, `villager_trades`, `trade_with_villager`, `remember_note`, `forget_note`, `explore`, `pick_up_items`). It doesn't touch Minecraft itself; it adds a `BotAction` for the bot to carry out. Compare *query tool*.

**Backend**: The Python process in `backend/`. The bot's "brain": it receives chat, runs the agent, and replies. It's the only part that costs tokens.

**Bot**: The Node process in `bot/`. The bot's "body": a Minecraft player controlled by code, using Mineflayer. It moves, senses and acts, and never costs tokens. Also refers to the in-game player itself, named **Claude**.

**BotAction**: The data shape of an action, defined in `backend/app/schema/chat.py`: a `type` (`follow`, `stay`, `come`, `goto`, `teleport`, `recover`, `collect`, `give`, `make`, `attack`, `guard`, `hunt`, `harvest`, `plant`, `breed`, `fish`, `shear`, `build`, `light`, `place`, `pillar`, `bridge`, `store`, `take`, `inspect`, `sort`, `mine`, `portal`, `enter_portal`, `throw_eye`, `trades`, `trade`, `explore` or `pickup`), plus `username` for actions aimed at a player, `x`/`y`/`z`/`label` for `goto` and `guard`, `item`/`count` for gathering and making, `target` (a mob, animal or crop) for `attack` and the farming jobs, and `count` for how many.

**ChatDeps**: The per-request deps object for the agent, in `backend/app/agents/agent.py`. Holds who is talking, the bot's state snapshot, the saved places, and the list of actions tools have recorded during the run.

**Companion**: The player the bot plays with: the first one it followed. Players who join later don't pull it away, and survival reflexes run to the companion when the bot is hurt.

**Family (ingredient family)**: Ingredients recipes treat as interchangeable: any planks, any log, any cobblestone-like block, coal or charcoal. The crafting planner counts a family together and picks the exact recipe variant (oak or birch planks, say) only when crafting.

**Functionality**: Something the player experiences, like "the bot follows me". Not a code unit: it's built from some combination of reflexes, tools and skills.

**Job (task)**: Something that takes a while, like "get 20 cobblestone" or handing items over. One runs at a time (`bot/core/tasks.js`); "stop", any new command, or dying cancels it. Several jobs asked for in one reply queue up and run in turn; cancelling drops the queue too. The bot announces progress and the result in chat, and the job is in the state snapshot.

**Guard job**: What `guard_area` starts: the bot stands at a spot (where the player is, or a saved place), fights hostile mobs within 12 blocks of it, and walks back after each fight, until the player gives another command (`guard` in `bot/reflexes/combat.js`).

**Building jobs**: Placing a block, lighting an area, building a shelter or hut, bridging and pillaring (`bot/jobs/building.js`). They share one placer that builds bottom-up against something solid, steps out of the way of its own blocks, and gathers or crafts materials it's short of.

**Chest memory**: What's in every chest the bot has opened, per world, in `backend/data/worlds/<world id>/chests.json` (`services/chests.py`). The bot reports a chest each time it opens one and forgets ones it finds gone; the agent reads it with `find_item`. Only as fresh as the bot's last look.

**Drop-off**: When the bot's inventory is full, it takes everything but tools, armor, food and torches to a chest near a saved place within 96 blocks, by itself when idle or in the middle of a gathering job (`bot/jobs/storage.js`).

**Blueprint**: A small fixed building in `bot/jobs/building.js`: "shelter" (3x3 inside, 2-high walls) or "hut" (5x5 inside, 3-high walls), each with a roof and a door facing the player.

**Event**: A message the bot sends the backend when something happens (jobs finished, deaths, trips). It goes in the journal at no cost. A failed job or a death can also get a reaction from the agent, when `REACT_TO_EVENTS` is on: rate-limited and within the budget.

**Memory**: Information the backend saves across restarts, per world: named places, chest contents, notes and the journal.

**Farming jobs**: Hunting, harvesting, planting, breeding, fishing and shearing (`bot/jobs/farming.js`). Each runs as a job, waits out reflexes (a fight, eating) and carries on, and says up front if the inventory is full. Hunting skips babies and leaves the last two adults of a kind so they can still breed.

**Journal**: What happened in a world: jobs finished (with how they turned out), deaths, trips to other dimensions. The bot reports them (`POST /events`), the backend keeps them per world (`journal.json`), and the agent sees the last few on every message and searches the rest with `recall`.

**Note**: Something the player asked the agent to remember for good ("the mine floods"), saved with `remember_note` per world (`notes.json`) and shown in the agent's instructions on every message.

**Budget**: The most Claude may cost in an hour (`BUDGET_DOLLARS_PER_HOUR`, default $0.50). Past it the bot handles only stay, follow and come by itself until the hour's spend drops (`services/budget.py`).

**Tip**: An unprompted chat message from a reflex in `bot/reflexes/alerts.js` (nightfall, a storm, a creeper by the player, ore in view, the player low on health). Free, and spaced at least 90 seconds apart.

**Mining trip**: What `mine_for` starts: look for an ore nearby, then dig down to the height it's most common at (diamonds around y -58, iron 16, gold -16) and tunnel outwards in 24-block legs until it has enough (`mineFor` in `bot/jobs/gathering.js`).

**Line of fire**: The path an arrow would take, plus a few blocks past the target. The bot won't shoot if a player, villager or pet is within 2 blocks of it (`someoneInTheWay` in `bot/reflexes/archery.js`).

**Man-made block**: A block a player probably placed: planks, glass, bricks, doors, chests, beds, torches, farmland, crops and so on (`isManMade` in `bot/core/movements.js`). The bot never breaks these, even while gathering.

**Make job**: What `make_item` starts: craft or smelt an item, working out and doing every step, including gathering materials and making tools to gather them (`bot/jobs/crafting.js`).

**Named place**: A position saved under a name ("home", "the mine") with `save_place`, kept per world in `backend/data/worlds/<world id>/places.json` so it survives restarts. The agent sees every saved name and its distance on each run. Sometimes called a waypoint.

**Query tool**: A tool that reads the world instead of changing it: `check_inventory`, `look_around`, `nearby_entities`, `where_are_we`, `find_item`, `recall`. It answers from the state snapshot (or, for `find_item`, the chest memory). Compare *action tool*.

**World id**: Which world the bot is in, so places and conversation memory stay separate per world. The bot takes it from the seed hash the server sends on login (`seed-b766…`), or from `MC_WORLD` if set, or the server address as a last resort (`bot/core/world.js`). Sent in the state snapshot as `world_id`.

**Protected area**: The 16 blocks (horizontally) around every saved place. The bot never digs or places blocks there.

**Reflex**: Behavior the bot runs by itself, triggered by game events or timers, with no backend call and no tokens. Following the player is a reflex, and so are the survival reflexes in `bot/reflexes/survival.js` (eat, armor, back off, escape lava and water, sleep) and the combat reflexes in `bot/reflexes/combat.js` (fight back, defend the companion, back away from creepers). Used for anything time-critical, frequent, or obvious. A command from the player cancels a running reflex.

**State snapshot**: The bot's current situation, sent with every chat message: world id, health, food, position, dimension, time, weather, inventory, nearby blocks and entities, where the player is, where the bot last died, its current job, what it's fighting and who it's following. Built by `bot/core/state.js`, defined as `BotState` in the schema.

**Skill**: A `SKILL.md` playbook under `skills/` describing how to do something multi-step. The agent only sees each skill's name and description until it decides to load one. Skills are knowledge; tools are actions.

---

## AI and the agent

**Agent**: The decision-maker: one Pydantic AI `Agent` defined in `backend/app/agents/agent.py`. Given a message, it asks Claude what to do, runs any tools Claude picks, and returns a reply.

**Agent run**: One full turn of the agent for one player message. It can involve several model requests: for example, one to choose a tool, then one to write the reply after the tool runs.

**Anthropic**: The company that makes Claude and runs the Claude API.

**API key**: The secret (`ANTHROPIC_API_KEY` in `.env`) that lets the backend call the Claude API and bills usage to your account. Never commit it.

**Capability**: Pydantic AI's way of bundling instructions, tools and hooks and plugging them into an agent with `capabilities=[...]`. `Skills` is a capability.

**Claude**: Anthropic's family of AI models. Also the in-game name of the bot.

**Claude API**: Anthropic's web service the backend calls to get responses from Claude. Charged per token.

**Context**: Everything the model sees for one request: instructions, the message, tool definitions, any loaded skills, and earlier tool results. Larger context means more input tokens.

**Conversation memory**: The player's last 5 exchanges with the bot, including tool calls, passed to the agent with each new message so follow-ups make sense. Kept separately per world, in memory only, and forgotten after 10 minutes of quiet (`backend/app/services/memory.py`).

**Deps (dependencies)**: Per-request data passed to `agent.run(..., deps=...)` that tools can read and write through `RunContext`. In this project, `ChatDeps`.

**Haiku 4.5**: `claude-haiku-4-5`, Anthropic's cheapest current model at $1 per million input tokens and $5 per million output tokens. This project's default model. Set `MODEL_NAME` in `.env` to use another.

**Harness**: In `pydantic-ai-harness`, a ready-made set of capabilities for an agent. This project uses only its `Skills` capability.

**Input tokens / output tokens**: Input tokens are what's sent to the model (instructions, message, tools, context); output tokens are what it writes back. Output tokens cost more. Both are logged per run in `agent.log`.

**Instructions**: The standing text that tells the agent who it is and how to behave (a friendly companion, short plain-text replies, follows by default). Sent on every request. Sometimes called a system prompt.

**LLM (large language model)**: An AI model that reads and writes text, such as Claude.

**load_capability**: The tool the `Skills` capability gives the agent to load a skill's full text. You'll see it in `agent.log` when a skill is used.

**Model**: The specific LLM version the agent uses, set by `MODEL_NAME` (default `claude-haiku-4-5`).

**Pydantic AI**: The Python framework the agent is built with. It handles the loop of calling the model, running tools and validating output.

**RunContext**: The object Pydantic AI passes as the first argument to a tool (`ctx`). `ctx.deps` gives the tool access to `ChatDeps`.

**SKILL.md**: The file that defines a skill. Its frontmatter has a `name` and a `description` (which the agent always sees), followed by the playbook (loaded only on demand).

**Token**: The unit models read and write in, roughly ¾ of an English word. API usage is billed per token.

**Tool**: A Python function the agent can choose to call, declared with `@agent.tool`. Claude sees its name, docstring and parameters and decides when to use it.

**Tool call**: The model asking to run a tool, with arguments. Logged in `agent.log` as `tool call <name>(<args>)`, followed by `tool result`.

**Toolset**: A Pydantic AI group of tools that can be filtered, renamed or combined. Planned for organizing tools by area (movement, crafting, combat) once there are many.

---

## Bot and Mineflayer

**Entity**: In Mineflayer, any non-block thing in the world: players, mobs, animals, dropped items, arrows. A player's entity is only available while they're within range of the bot.

**Goal**: A pathfinder target. Examples: `GoalFollow` (stay near a moving entity), `GoalNear` (get close to a spot), `GoalBlock` (stand on an exact block). Setting the goal to `null` stops movement.

**GoalFollow**: The goal behind following. Keeps the bot within a set range (3 blocks here) of an entity and keeps re-routing as it moves.

**Mineflayer**: The JavaScript library that lets code join Minecraft Java as a player. It handles the connection, world state, chat, inventory, digging, placing and crafting.

**Movements**: The pathfinder settings that decide how the bot may move: whether it can dig (`canDig`: only during gathering jobs), how far it may drop, how much it avoids water, which doors it can open, and whether it may place blocks to climb or bridge (also only during jobs). This project's rules are in `bot/core/movements.js`.

**Offline mode (auth: 'offline')**: How the bot logs in: with just a username, no Microsoft account. The world it joins must allow offline players.

**Pathfinder (mineflayer-pathfinder)**: The Mineflayer plugin that works out a walkable route and moves the bot along it, including jumping, swimming and climbing.

**patch-package**: Keeps small fixes to installed npm packages as files in `bot/patches/` and reapplies them on every `npm install`. Used for door bugs in `mineflayer-pathfinder` and a step-up bug in `prismarine-physics`.

**Player chat**: A chat message typed by a player, which Minecraft sends with the sender's UUID. The bot only answers these, not server or command messages.

**Plugin**: An add-on that extends Mineflayer, loaded with `bot.loadPlugin(...)`. In use: `mineflayer-pathfinder`, `mineflayer-auto-eat`, `mineflayer-armor-manager` and `mineflayer-tool`. Combat doesn't use `mineflayer-pvp` (unmaintained since 2021); `bot/reflexes/combat.js` has its own short attack loop. (`mineflayer-collectblock` was tried and dropped: it could wait forever for an item drop.)

**Spawn**: The moment the bot appears in the world after connecting, or after dying. The bot sets up movement and starts following only after spawn.

---

## Backend and tooling

**.env**: The local settings file at the repo root: API key, model, Minecraft host and port, and optionally a world name (`MC_WORLD`). Ignored by git. `.env.example` is the committed template.

**Endpoint**: A URL the backend answers. `POST /chat` takes a chat message and returns a reply and actions; `GET /places` and `GET /chests` give the bot a world's saved places and remembered chests when it joins; `POST /chests` and `DELETE /chests` keep the chest memory up to date; `GET /health` checks the backend is up.

**FastAPI**: The Python web framework the backend uses to serve `/chat`.

**Lifespan**: FastAPI's startup/shutdown hook. The backend uses it to set up logging when the server starts.

**Logs**: Files in `backend/logs/`:
- `agent.log`: each agent run's message, tool calls, reply, time and tokens. Starts a new file at 5 MB and keeps 5 old ones.
- `bot.log`: bot actions, such as joining, chat heard and said, following or staying, reflexes, jobs (including each block dug), deaths and errors.
- `bot-console.log`: the bot's raw console output, including library warnings.

**In-game check**: A script in `bot/scripts/` that joins as a second player, ClaudeTester, sets up a situation with commands, and checks what the bot does. Needs cheats on. Checks tag the mobs they summon and only kill those, take back the tools they give, and (farming, building, storage) record and restore every block of the patch they test on. Shared helpers are in `bot/scripts/tester.js`.

**Node / npm**: Node runs the bot's JavaScript; npm installs its packages (`cd bot && npm install`, then `npm start`, or `npm test` for the unit tests).

**Pydantic**: The Python library for typed data models. `ChatRequest`, `ChatResponse` and `BotAction` are Pydantic models.

**Schema**: The shape of the data the bot and backend exchange, defined in `backend/app/schema/chat.py`. Both sides must agree on it.

**uv**: The Python package and environment manager (`uv sync` to install, `uv run` to run).

**Uvicorn**: The server that runs the FastAPI app. With reload on, it restarts the backend whenever a Python file changes.

---

## Minecraft

**Allow Cheats (Allow Commands)**: An option on the Open to LAN screen that lets players in the world use commands like `/tp`. The bot needs it to teleport. It only lasts until the world closes.

**Biome**: A region type (plains, desert, taiga) that determines terrain, plants and mobs.

**Block**: One cube in the world: dirt, stone, ore, log. Identified by name in code (`oak_log`, `iron_ore`).

**Chunk**: A 16×16 column of the world, loaded and sent as a unit. The bot only knows about chunks near it.

**Dimension**: The Overworld, the Nether or the End.

**Crafting table / furnace (workstation)**: Blocks needed for most tools (crafting table) and for smelting (furnace). The bot uses one within 16 blocks, or makes one, places it, and picks it back up when the job is done.

**Durability**: How many more uses a tool or armor piece has before it breaks.

**Smelting**: Cooking an item in a furnace with fuel: raw iron to iron ingots, sand to glass, logs to charcoal, raw meat to cooked. About 10 seconds per item. Minecraft data has no smelting recipes, so the common ones are listed in `bot/jobs/crafting.js`.

**Hostile mob**: A mob that attacks players, such as a zombie, skeleton, spider or creeper. Most spawn in the dark.

**Hunger (food)**: A bar from 0 to 20. Health only regenerates at 18 or more; at zero, the player starts taking damage. Mineflayer exposes it as `bot.food`.

**Java Edition**: The PC version of Minecraft. Mineflayer only supports Java; it doesn't work with Bedrock (console, mobile, Microsoft Store).

**LAN / Open to LAN**: Hosting a single-player world for others on the same home network (Esc → Open to LAN). You can type a port on that screen; otherwise it picks a random one, which then has to go in `MC_PORT`. On a LAN world every player must sleep for the night to skip, which is why the bot sleeps when you do.

**Mob**: Any creature. Passive mobs (cows, sheep) don't attack; hostile mobs do.

**Online mode**: A server setting that requires every player to have a real Microsoft account. The bot uses offline mode, so the world must have online mode off.

**Port**: The number that, together with the PC's IP address (`MC_HOST`), tells the bot where to connect (`MC_PORT`). `25565` is the default for dedicated servers; Open to LAN picks a random one.

**Server (dedicated)**: A standalone Minecraft server program (`server.jar`). Unlike Open to LAN, it can keep a fixed port and run with `online-mode=false` set in `server.properties`.

**Tick**: Minecraft's unit of game time, 20 per second (50 ms). Reflexes like following update on every tick. A full day is 24,000 ticks, about 20 minutes.

**Y level**: Height in the world. Ores are found at specific Y levels; diamonds are most common near the bottom of the world.
