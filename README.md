# minecraft-agent

A Claude-powered companion that joins your Minecraft world and plays with you.

```
You (in Minecraft) ⇄ Minecraft server ⇄ Mineflayer bot (bot/, Node)
                                              ⇅ HTTP
                                       FastAPI + Pydantic AI agent (backend/, Python)
                                              ⇅
                                           Claude
```

- **`bot/`**: a [Mineflayer](https://github.com/PrismarineJS/mineflayer) bot that logs into the server, sends in-game chat to the backend, and says the reply.
- **`backend/`**: FastAPI app with the Pydantic AI agent (`app/agents/agent.py`) and a `POST /chat` endpoint.
- **`skills/`**: `SKILL.md` files the agent loads only when it needs them (for example `survive-first-night`).
- **`docs/`**: notes on how Pydantic AI agents, tools, capabilities and skills fit together.

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

Teleporting (`"tp to me"`) needs commands allowed: choose **Allow Cheats: ON** when you open the world to LAN.

## Test

```sh
cd backend
uv run pytest
```

## Roadmap

The full list is in [docs/survival-functionality-plan.md](docs/survival-functionality-plan.md).

- [x] Chat buddy: joins the world and talks through the agent, with errors shown in chat
- [x] World awareness: health, inventory, nearby blocks and mobs, time of day passed to the agent (Phase 1)
- [x] Movement: follow, stay, come here, go to coordinates, named places, doors, teleport (Phase 2)
- [x] Staying alive: eat, wear armor, back off when hurt, sleep, get items back after dying (Phase 3)
- [ ] Gathering and crafting: chop, mine, craft, smelt (Phases 4–5, need the task system)
- [ ] Combat, farming, building, base and storage (Phases 6–9)
- [ ] Long-term goals and companionship (Phases 10–11)
