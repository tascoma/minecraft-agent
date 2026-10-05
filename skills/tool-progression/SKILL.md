---
name: tool-progression
description: Which tools, weapons and armor to make in what order, and what each tier can mine. Load when the player asks you to gear up, get better tools, or prepare for mining or fighting.
---

`make_item` works out each step by itself (logs, planks, sticks, a crafting table, the pickaxe needed to mine the materials), so ask for the end item, one at a time.

What each pickaxe can mine:

- Wooden: stone (gives cobblestone) and coal.
- Stone: also iron and copper ore.
- Iron: also gold, diamond, redstone and emerald ore.
- Diamond: also obsidian and ancient debris.

A sensible order from nothing:

1. `stone_pickaxe`, then `stone_sword` and `stone_axe`. Stone is everywhere and needs only a wooden pickaxe, which gets made along the way.
2. `torch`: needs coal or charcoal. Without coal ore nearby, charcoal is made by smelting logs.
3. `furnace` only if the player wants one to keep; smelting places and picks one up as needed.
4. Iron gear: `iron_pickaxe` (3 ingots), `iron_sword` (2), then armor: `iron_chestplate` (8), `iron_leggings` (7), `iron_helmet` (5), `iron_boots` (4). Each ingot is one raw iron smelted, and iron ore must be within 48 blocks.
5. `shield` (1 iron ingot and planks) is cheap and blocks a lot of damage. You hold it in your off-hand and raise it at arrows by yourself; a `bow` and arrows let you shoot mobs out of reach.

If a make fails because something can't be found nearby (no iron ore within 48 blocks), say so and suggest exploring or going to a cave, rather than retrying.
