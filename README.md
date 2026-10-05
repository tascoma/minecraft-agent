# minecraft-agent

A Claude-powered companion that joins your Minecraft world and plays with you.

```
You (in Minecraft) ⇄ Minecraft server ⇄ Mineflayer bot (bot/, Node)
                                              ⇅ HTTP
                                       FastAPI + Pydantic AI agent (backend/, Python)
                                              ⇅
                                           Claude
```

- **`bot/`**: a [Mineflayer](https://github.com/PrismarineJS/mineflayer) bot. It sends your chat (plus a snapshot of its health, inventory and surroundings) to the backend, says the reply, and carries out the agent's actions as jobs (gathering, crafting, farming, building, storage). Reflexes like following, eating, fighting and backing off from mobs run here with no tokens.
- **`backend/`**: FastAPI app with the Pydantic AI agent (`app/agents/agent.py`), its tools, a `POST /chat` endpoint, and per-world memory of saved places and chest contents.
- **`skills/`**: `SKILL.md` files the agent loads only when it needs them (for example `survive-first-night`).
- **`docs/`**: [architecture](docs/architecture.md) (how it fits together), the [survival functionality plan](docs/survival-functionality-plan.md) (what's done and what's next) and a [glossary](docs/glossary.md).

Requires **Minecraft Java Edition**. Mineflayer does not support Bedrock.

## Setup

```sh
cp .env.example .env        # then fill in ANTHROPIC_API_KEY
uv sync                     # Python deps
cd bot && npm install       # Node deps
```

## Run

1. Open a Java Edition world to LAN (Esc → Open to LAN) or start a local server in offline mode. Set `MC_HOST` / `MC_PORT` in `.env` to match. Open to LAN picks a random port and shows it in chat.
2. Start the backend:
   ```sh
   cd backend
   uv run python -m app.main
   ```
3. Start the bot in another terminal:
   ```sh
   cd bot
   npm start
   ```
4. Type in Minecraft chat. The bot replies.

Each world keeps its own saved places, chest contents and chat memory. The bot tells worlds apart by their seed, so reopening a world on a new LAN port is still the same world; the id is logged on join (`world: seed-…`). Two worlds with the same seed share data unless you name them with `MC_WORLD` in `.env`.

Teleporting (`"tp to me"`) needs commands allowed: choose **Allow Cheats: ON** when you open the world to LAN.

## What you can ask

Talk to it in plain chat; these are examples, not fixed commands.

| | |
|---|---|
| Moving | "follow me", "stay here", "come here", "go to 100 64 -200", "remember this as home", "go home", "tp to me" |
| Looking | "what do you have?", "what's around?", "where are we?", "where's my iron?" |
| Gathering and making | "get 20 cobblestone", "make a stone pickaxe", "make 8 torches", "give me the logs" |
| Fighting | "kill that zombie", "guard this spot", "guard home" (it fights back and defends you by itself) |
| Food and farming | "hunt 2 cows", "make cooked beef", "harvest the wheat", "plant 16 wheat", "breed the cows", "catch 5 fish", "shear the sheep" |
| Building | "build a shelter", "build a hut out of wood at home", "put a chest here", "light up the area", "bridge 10 blocks east", "pillar up 5" |
| Storage | "put everything away", "put away the cobblestone", "grab 10 iron", "check the chests", "sort the chests" |
| Stopping | "stop": any new request also replaces the current job |

By itself, with no tokens, it follows you, eats, wears the best armor it has, backs off when badly hurt, gets out of lava and water, sleeps when you sleep, fights mobs that attack you or it, backs away from creepers, raises a shield at arrows, and takes a full inventory to a chest at a saved place.

## Test

```sh
cd backend && uv run pytest    # backend: tools, places, chests, memory, errors, status text
cd bot && npm test             # bot: movement rules, digging targets, jobs, crafting planner, combat and bow aim,
                               #      farming, building blueprints, storage
```

In-game checks drive a second player, **ClaudeTester**, through real situations and print PASS or FAIL. They need the backend and bot running and a world with **cheats on**. They change the world, so a test world is safest, but they're written to clean up after themselves:

- They set the time to day, give the bot items, summon mobs, and the survival check kills the bot once.
- Every mob they summon is tagged, and only tagged mobs are ever killed.
- The gathering and crafting checks really chop trees and mine near the bot, and that isn't put back.
- The farming, building and storage checks work on a patch of open grass near the bot (levelling it if needed), record every block there first, and put each one back exactly at the end.
- Tools and armor they give are taken back; stackable items (blocks, arrows, food) stay with the bot, since `/clear` can't tell them from the bot's own.
- The checks stop the bot following you first, and the combat check costs you half a heart if you're standing near the bot.

```sh
cd bot
npm run check:survival     # commands ignored, armor, backing off, death and item recovery
npm run check:gathering    # logs, pickaxe needed, progress, stop, giving items
npm run check:crafting     # stone pickaxe from nothing, torches, iron ingots with a furnace
npm run check:combat       # fights back, defends you, creepers, kills on request, spares villagers, bow, shield, guarding
npm run check:farming      # hunt, cook, breed, shear, harvest and replant, plant by water, fish
npm run check:building     # chest, shelter with door, torches, pillar, bridge
npm run check:storage      # look in, find, sort, put away, take out, forget broken chests
```

## Roadmap

The full list is in [docs/survival-functionality-plan.md](docs/survival-functionality-plan.md).

- [x] Chat buddy: joins the world and talks through the agent, with errors shown in chat
- [x] World awareness: health, inventory, nearby blocks and mobs, time of day passed to the agent (Phase 1)
- [x] Movement: follow, stay, come here, go to coordinates, named places, doors, teleport (Phase 2)
- [x] Staying alive: eat, wear armor, back off when hurt, sleep, get items back after dying (Phase 3)
- [x] Gathering: chop trees, mine stone and ores, dig sand and dirt, hand items over, never near your base (Phase 4)
- [x] Crafting and smelting: "make a stone pickaxe" from nothing, torches, iron ingots; gathers what's missing (Phase 5)
- [x] Combat: fight back, defend you, back away from creepers, attack on request, never hit players, villagers or pets; guard a place, shoot with a bow, block arrows with a shield (Phase 6)
- [x] Food and farming: hunt, cook, harvest and replant, plant a field by water, breed, fish, shear (Phase 7)
- [x] Building: place blocks, light an area, emergency shelter or hut with a door, bridge, pillar up (Phase 8)
- [x] Base and storage: put away, take out, remember and sort chests, drop off a full inventory at the base (Phase 9)
- [ ] Long-term goals: iron gear, diamonds, the Nether, the End (Phase 10)
- [ ] Being a good companion: long-term memory, tips, sharing work, a token budget (Phase 11)
