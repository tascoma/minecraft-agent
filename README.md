# minecraft-agent

A Claude-powered companion that joins your Minecraft world and plays with you.

```
You (in Minecraft) ⇄ Minecraft server ⇄ Mineflayer bot (bot/, Node)
                                              ⇅ HTTP
                                       FastAPI + Pydantic AI agent (backend/, Python)
                                              ⇅
                                           Claude
```

- **`bot/`**: a [Mineflayer](https://github.com/PrismarineJS/mineflayer) bot. It sends your chat (plus a snapshot of its health, inventory and surroundings) to the backend, says the reply, and carries out the agent's actions. Reflexes like following, eating and backing off from mobs run here with no tokens.
- **`backend/`**: FastAPI app with the Pydantic AI agent (`app/agents/agent.py`), its tools, and a `POST /chat` endpoint.
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

Each world keeps its own saved places and chat memory. The bot tells worlds apart by their seed, so reopening a world on a new LAN port is still the same world; the id is logged on join (`world: seed-…`). Two worlds with the same seed share data unless you name them with `MC_WORLD` in `.env`.

Teleporting (`"tp to me"`) needs commands allowed: choose **Allow Cheats: ON** when you open the world to LAN.

## Test

```sh
cd backend && uv run pytest    # backend: tools, places, memory, errors, status text
cd bot && npm test             # bot: movement rules, what to dig for an item, jobs, crafting planner
```

In-game checks drive a second player, **ClaudeTester**, through real situations and print PASS or FAIL. They need the backend and bot running and a **test world with cheats on**, because they change it: they set the time to day, give and clear items, summon a husk, kill the bot, and dig near it.

```sh
cd bot
npm run check:survival     # commands ignored, armor, backing off, death and item recovery
npm run check:gathering    # logs, pickaxe needed, progress, stop, giving items
npm run check:crafting     # stone pickaxe from nothing, torches, iron ingots with a furnace
npm run check:combat       # fights back, defends you, backs away from creepers, kills on request, spares villagers, bow, shield, guarding (costs you half a heart)
```

## Roadmap

The full list is in [docs/survival-functionality-plan.md](docs/survival-functionality-plan.md).

- [x] Chat buddy: joins the world and talks through the agent, with errors shown in chat
- [x] World awareness: health, inventory, nearby blocks and mobs, time of day passed to the agent (Phase 1)
- [x] Movement: follow, stay, come here, go to coordinates, named places, doors, teleport (Phase 2)
- [x] Staying alive: eat, wear armor, back off when hurt, sleep, get items back after dying (Phase 3)
- [x] Gathering: chop trees, mine stone and ores, dig sand and dirt, hand items over, never near your base (Phase 4)
- [x] Crafting and smelting: "make a stone pickaxe" from nothing, torches, iron ingots; gathers what's missing (Phase 5)
- [x] Combat: fight back, defend you, back away from creepers, attack on request, never hit players, villagers or pets ; guard a place, shoot with a bow, block arrows with a shield (Phase 6)
- [ ] Farming, building, base and storage (Phases 7–9)
- [ ] Long-term goals and companionship (Phases 10–11)
