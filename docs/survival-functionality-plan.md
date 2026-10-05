# Survival functionality plan

Everything the minecraft-agent should be able to do as a survival companion, grouped into phases. Each phase builds on the ones before it.

See [architecture.md](architecture.md) for what **reflex**, **tool**, and **skill** mean and where each piece of code lives.

**How to read the tables:**

- **Type** says where the behavior lives:
  - **Reflex** runs in the bot automatically, with no LLM call and no tokens.
  - **Tool** is an action the agent can choose to take when you ask for something in chat.
  - **Skill** is a `SKILL.md` playbook the agent loads when it needs to plan multi-step work.
- **Built on** is the Mineflayer API or plugin that does the actual work.
- ✅ is done, 🔲 is not started.

---

## Phase 0: Foundation ✅

| Functionality | Type | Built on | Status |
|---|---|---|---|
| Join a LAN world or server | Bot | `mineflayer.createBot` | ✅ |
| Chat with the player through the agent | Tool loop | `POST /chat` | ✅ |
| Log every action (agent and bot) | Bot + backend | `backend/logs/` | ✅ |
| Follow the player loosely (3 blocks) | Reflex | `mineflayer-pathfinder` `GoalFollow` | ✅ |
| "Stay here" / "follow me" on request | Tool | `stay_here`, `follow_player` | ✅ |
| Survive-first-night advice | Skill | `skills/survive-first-night` | ✅ |

## Phase 1: World awareness ✅

The agent can't make good decisions without knowing what's going on. Before the bot can do much, every chat request should carry a snapshot of the bot's state.

| Functionality | Type | Built on | Status |
|---|---|---|---|
| Send health, hunger, position, dimension, time of day and weather with each chat | Bot → backend | `bot.health`, `bot.food`, `bot.entity.position`, `bot.time` | ✅ |
| Report inventory contents (`check_inventory`) | Tool | `bot.inventory.items()` | ✅ |
| Describe nearby blocks (ores, trees, water, lava) (`look_around`) | Tool | `bot.findBlocks` | ✅ |
| Describe nearby entities (mobs, animals, players, dropped items) (`nearby_entities`) | Tool | `bot.entities` | ✅ |
| Tell the player where it is and how far away (`where_are_we`) | Tool | positions + distance | ✅ |
| Notice and report important events ("I'm hurt", "creeper nearby", "it's getting dark") | Reflex → chat | `health` and `time` events, 1 s creeper scan | ✅ |
| Auto-reconnect when the world closes and comes back | Bot | `end` event + retry | ✅ |

## Phase 2: Movement and navigation

The bot does one thing at a time: follow, stand still, or walk somewhere. When it walks somewhere it says in chat whether it arrived or got stuck, without calling the agent. The full task queue waits for Phase 4.

| Functionality | Type | Built on | Status |
|---|---|---|---|
| Come to the player now and wait there ("come here") | Tool | `come_here`, `GoalNear` | ✅ |
| Go to coordinates | Tool | `go_to`, `GoalNear` / `GoalXZ` | ✅ |
| Remember named places ("this is home", "the mine") and go back to them | Tool + memory | `save_place`, `go_to_place`, `forget_place`; `backend/data/worlds/<world id>/places.json` | ✅ |
| Say when it arrives or can't find a way | Bot | `pathfinder.goto` promise | ✅ |
| Explore in a direction and report what it finds | Tool | `GoalXZ` + Phase 1 scans; needs bot → backend events | 🔲 |
| Swim, climb ladders, open doors and gates | Reflex | `bot/movements.js` (wooden doors and gates; iron ones need redstone) | ✅ |
| Avoid lava, cliffs and deep water | Reflex | `bot/movements.js`: lava avoided, `maxDropDown` 3, `liquidCost` 5 | ✅ |
| Teleport to the player ("tp to me") | Tool | `teleport_to_player`, `/tp`; needs Allow Cheats on | ✅ |
| Build up or bridge across gaps when stuck | Reflex | `Movements.scafoldingBlocks` with dirt or cobblestone; during gathering jobs only, never while following and never in protected areas | ✅ |
| Stop whatever it's doing ("stop") | Tool | `stay_here` | ✅ |

## Phase 3: Staying alive (reflexes)

These run automatically, without being asked and without any tokens. They live in `bot/survival.js`. Any command from the player cancels a running reflex.

Tested in game with a second player running commands (`/give`, `/damage`, `/summon husk`, `/kill`): eating, armor, backing off, sleeping and item recovery all work. Escaping lava, fire and deep water hasn't been tested in game yet.

| Functionality | Type | Built on | Status |
|---|---|---|---|
| Eat when hungry; top up to 18 when hurt so it heals; rotten flesh only when starving | Reflex | `mineflayer-auto-eat` | ✅ |
| Ask the player for food when starving with nothing to eat | Reflex → chat | `health` event | ✅ |
| Equip the best armor it has, whether picked up or put straight in its inventory | Reflex | `mineflayer-armor-manager` + inventory watch | ✅ |
| Use the right tool for each block | Reflex | Moved to Phase 4: the bot doesn't dig yet | 🔲 |
| Back off when hurt and a hostile mob is near: run to the player, or away from the mob | Reflex | pathfinder `GoalFollow` / `GoalInvert` | ✅ |
| Get out of lava, run to water when on fire, swim up when out of air | Reflex | `isInLava`, entity fire flag, `oxygenLevel` | ✅ |
| Sleep when the player sleeps (on LAN, every player must sleep for the night to skip) | Reflex | `entitySleep` event, `bot.sleep` | ✅ |
| After dying, say where, and go back for its items on request ("get my stuff"); the agent knows how long until they despawn | Reflex + tool | `death` / `respawn` events, `recover_items`, `last_death` in the state | ✅ |

## Phase 4: Gathering resources

Gathering runs as a **job** (`bot/tasks.js`): one at a time, cancelled by "stop" or any new command. The bot reports progress and the result in chat itself, and the current job is in the state snapshot so the agent can say what it's doing.

The bot digs only while gathering, never within 16 blocks (horizontally) of a saved place, and never through blocks a player probably placed (planks, glass, bricks, doors, chests, beds, farmland and so on; see `isManMade` in `bot/movements.js`). While following or walking it never digs or places blocks.

| Functionality | Type | Built on | Status |
|---|---|---|---|
| Chop trees ("get 10 logs") | Tool | `collect`, pathfinder + `bot.dig` | ✅ |
| Use the right tool for each block | Reflex | `mineflayer-tool` | ✅ |
| Mine a block type ("get 20 cobblestone", "get some coal"); makes the pickaxe it needs first | Tool | `collect`, block drop data from `minecraft-data` | ✅ |
| Collect sand, gravel, dirt, clay and other surface blocks | Tool | `collect` | ✅ |
| Pick up the drops of blocks it breaks (up to 5 seconds per block) | Reflex | walking to item entities | ✅ |
| Pick up any dropped items nearby | Reflex | Not built: it would also grab the player's drops | 🔲 |
| Give items to the player ("give me your coal") | Tool | `give_items`, `bot.toss` | ✅ |
| Strip-mine or branch-mine at a chosen Y level | Tool + skill | `bot.dig` + pathfinder | 🔲 |
| Never mine through the player's builds | Reflex | protected areas around saved places, man-made block list | ✅ |

Tested in game: logs, cobblestone without and with a pickaxe, stopping a job, and giving items. Nothing was dug inside the protected area around home.

## Phase 5: Crafting and smelting

One tool, `make_item(item, count)`, runs a job (`bot/crafting.js`) that works out the whole chain as it goes: logs → planks → sticks → crafting table → tool. It gathers missing raw materials and makes any tool it needs to gather them (a wooden pickaxe for stone, a stone pickaxe for iron). Interchangeable ingredients (any planks, any log, any cobblestone-like block, coal or charcoal) are planned together, and the exact recipe is picked when crafting from whatever the bot has. A crafting table or furnace within 16 blocks is used; otherwise the bot makes one, places it, and picks it back up afterwards (a furnace only with a pickaxe).

| Functionality | Type | Built on | Status |
|---|---|---|---|
| Craft an item, including the steps leading up to it ("make a stone pickaxe") | Tool | `make_item`, `bot.recipesFor`, `bot.craft` | ✅ |
| Place and use a crafting table when the recipe needs one, then pick it back up | Tool | `bot.placeBlock`, `bot.craft`, `bot.dig` | ✅ |
| Smelt ores and cook food in a furnace, choosing fuel | Tool | `make_item`, `bot.openFurnace`, smelting table in `crafting.js` | ✅ |
| Gather missing raw materials during a craft, making the tools needed to mine them | Tool | `gathering.gather` with a tool maker | ✅ |
| Make tools, weapons and armor as materials allow | Skill | `skills/tool-progression` | ✅ |
| Replace a tool when it's about to break | Reflex | Partly: when a job needs a tool it doesn't have, it makes one | 🔲 |
| Make torches, chests, beds, doors and other basics | Tool | `make_item` | ✅ |

Tested in game (`npm run check:crafting`): a stone pickaxe from an empty inventory, torches, and iron ingots with a furnace it made and placed.

## Phase 6: Combat and defense

| Functionality | Type | Built on | Status |
|---|---|---|---|
| Fight back when attacked | Reflex | `mineflayer-pvp` | 🔲 |
| Defend the player from hostile mobs | Reflex | `mineflayer-pvp` + `entityHurt` | 🔲 |
| Attack a target on request ("kill that zombie") | Tool | `mineflayer-pvp` | 🔲 |
| Guard an area or the base | Tool | patrol + `mineflayer-pvp` | 🔲 |
| Back away from creepers instead of meleeing them | Reflex | creeper distance check | 🔲 |
| Use a bow and shield | Reflex | `bot.activateItem`, `mineflayer-hawkeye` | 🔲 |
| Never hit the player, pets or villagers | Reflex | target filter | 🔲 |

## Phase 7: Food and farming

| Functionality | Type | Built on | Status |
|---|---|---|---|
| Hunt animals for food (cows, pigs, chickens, sheep) | Tool | `mineflayer-pvp` + collect drops | 🔲 |
| Cook raw meat | Tool | furnace (Phase 5) | 🔲 |
| Harvest and replant crops (wheat, carrots, potatoes) | Tool | `bot.dig` + `bot.placeBlock` seeds | 🔲 |
| Start a farm: till soil near water and plant | Tool + skill | hoe + `bot.activateBlock` | 🔲 |
| Breed animals | Tool | `bot.activateEntity` with food | 🔲 |
| Fish | Tool | `bot.fish` | 🔲 |
| Shear sheep for wool | Tool | `bot.activateEntity` with shears | 🔲 |

## Phase 8: Building

| Functionality | Type | Built on | Status |
|---|---|---|---|
| Place a block where asked | Tool | `bot.placeBlock` | 🔲 |
| Light up an area with torches | Tool | light-level scan + `placeBlock` | 🔲 |
| Build a simple emergency shelter before night | Tool + skill | small fixed blueprint | 🔲 |
| Build from a small blueprint (walls, floor, roof, door) | Tool + skill | blueprint → block list | 🔲 |
| Bridge across a gap or pillar up | Tool | `placeBlock` under/ahead | 🔲 |
| Place and fill a bed, chest, crafting table or furnace at the base | Tool | `placeBlock` | 🔲 |

## Phase 9: Base and storage

| Functionality | Type | Built on | Status |
|---|---|---|---|
| Remember where home is | Memory | saved waypoint | 🔲 |
| Store items in chests ("put away the cobblestone") | Tool | `bot.openContainer` | 🔲 |
| Take items from chests ("grab iron from the chest") | Tool | `bot.openContainer` | 🔲 |
| Keep a record of what's in each chest | Memory | container snapshots | 🔲 |
| Sort chests by item type | Tool + skill | container moves | 🔲 |
| Drop off a full inventory at home automatically | Reflex | inventory-full check | 🔲 |

## Phase 10: Progression goals

Multi-step goals that combine everything above. The agent plans them with skills and runs them as a series of tool calls, reporting progress as it goes.

| Functionality | Type | Status |
|---|---|---|
| Get a full set of iron tools and armor | Skill | 🔲 |
| Find diamonds | Skill | 🔲 |
| Set up an enchanting table with bookshelves | Skill | 🔲 |
| Build a Nether portal and go to the Nether together | Skill | 🔲 |
| Get blaze rods and ender pearls | Skill | 🔲 |
| Find a stronghold and prepare for the End | Skill | 🔲 |
| Trade with villagers | Tool + skill | 🔲 |

## Phase 11: Being a good companion

| Functionality | Type | Status |
|---|---|---|
| Remember the last few things said, so follow-ups like "get it" work | Memory | ✅ |
| Remember things about the player and past sessions (preferences, base locations, what happened) | Memory | 🔲 |
| Give useful tips without being asked, at a sensible rate ("night in 1 minute") | Reflex → chat | 🔲 |
| Split up work ("you mine, I'll build") and report back when done | Tool + task system | 🔲 |
| Tell the player what it's currently doing on request | Tool | 🔲 |
| Keep a token budget per hour so idle chatter can't run up costs | Backend | 🔲 |

---

## Cross-cutting work

Phases 4 onward need these before they work well:

1. **Task system.** *Partly done.* Jobs like "get 20 cobblestone" run one at a time, can be cancelled, and report progress and results in chat (`bot/tasks.js`). Still to come: a queue of several jobs, and telling the agent when a job ends (needs bot → backend events).
2. **Bot → backend events.** The bot reports things that happen (task finished, under attack, low health) so the agent can react, not only when the player chats. Each event costs tokens, so they must be rate-limited and only sent when the agent needs to decide something.
3. **Persistent memory.** *Partly done.* Named places are saved per world (`backend/data/worlds/<world id>/`), keyed by the world id the bot sends. Chest contents and player notes should go in the same per-world folder.
4. **Safety rules.** Never attack players, never dig inside protected areas (done), never take from the player's chests unless asked. Enforced in the bot, not left to the model.
5. **Tests.** *Done for Phases 1–4:* backend unit tests (`uv run pytest`), bot unit tests (`npm test`), and in-game checks with a second player (`npm run check:survival`, `npm run check:gathering`). Each new phase should add to all three.

## Suggested order

1. ~~Phase 1 (world awareness) and the task system.~~ Done; the task system runs one job at a time.
2. ~~Phase 3 (staying alive)~~ done. Phase 6 reflexes (fighting back) are next: night mobs still kill it mid-job.
3. ~~Phases 4 and 5 (gathering, crafting)~~ done. The bot can now go from nothing to stone tools, torches and iron ingots by itself.
4. Phases 7–9 (farming, building, base).
5. Phases 10–11 (long-term goals and companionship).
