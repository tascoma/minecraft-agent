---
name: find-diamonds
description: How to find diamonds. Load when the player asks for diamonds, a diamond pickaxe or diamond gear.
---

Diamonds are deep: most common around y -58, near the bottom of the world, inside deepslate. Mining diamond ore needs an iron pickaxe or better.

1. `mine_for` "diamond" with the count wanted (3 for a pickaxe, 2 for an enchanting table, 24 for full armor and tools). It makes an iron pickaxe first if needed, digs down to y -58, and tunnels outwards in legs until it has enough or gives up.
2. Warn the player before starting: it's a long trip, and lava and mobs are common that deep. Suggest they give you food and torches, and armor if you have none.
3. When it reports back, you're deep underground: offer to come back up ("tp to me" or "follow me").
4. Then `make_item` "diamond_pickaxe" first: obsidian (for a Nether portal or enchanting table) needs it.
