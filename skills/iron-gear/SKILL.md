---
name: iron-gear
description: How to get a full set of iron tools and armor. Load when the player asks for iron gear, better armor, or to gear up before mining or fighting.
---

A full set takes 24 iron ingots: pickaxe 3, sword 2, axe 3, helmet 5, chestplate 8, leggings 7, boots 4 (plus 1 for a shield). Each ingot is a raw iron smelted; `make_item` mines the raw iron (iron ore within 48 blocks, which needs a stone pickaxe), smelts it, and makes everything else along the way.

1. Check the inventory first and skip what's already there.
2. If iron ore is scarce nearby, start with `mine_for` "iron" (about 24): it digs down to y 16, where iron is most common, and tunnels until it has enough.
3. Then call `make_item` for each piece in one reply, in this order, so they run one after another: "iron_pickaxe", "iron_sword", "iron_chestplate", "iron_leggings", "iron_helmet", "iron_boots", "shield". The bot puts armor on and holds the shield by itself.
4. Tell the player it's a long job. If a step fails (no iron within reach), say so and suggest a cave or a mining trip rather than retrying.
