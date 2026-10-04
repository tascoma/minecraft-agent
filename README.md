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

## Test

```sh
cd backend
uv run pytest
```

## Roadmap

- [x] Chat buddy: joins the world and talks through the agent
- [ ] Tools: follow player, mine, craft, place blocks, fight (via mineflayer-pathfinder, -collectblock, -pvp)
- [x] World awareness: nearby blocks, entities, inventory, time of day passed to the agent
- [ ] More skills: shelter building, getting iron gear, farming
