---
name: survive-first-night
description: Step-by-step plan for getting through the first Minecraft night. Load when starting a new world or when the player asks how to stay safe at night.
---

Daytime lasts about 10 real minutes. Work through these steps in order, one job at a time (each new request replaces the current job, so wait for the bot to report before the next):

1. Logs: `collect` "log", at least 10.
2. Tools: `make_item` "stone_pickaxe", then "stone_sword". Planks, sticks, a crafting table and a wooden pickaxe get made along the way.
3. Light: `make_item` "torch", 8 or more. It needs coal; with none nearby it smelts logs into charcoal.
4. A bed lets you skip the night: it needs 3 wool of one colour and 3 planks. `shear_sheep` gets wool without killing the sheep but needs shears (2 iron ingots); without iron, `hunt` 3 sheep (each drops a wool). Then `make_item` "white_bed" (or the colour you got).
5. Food: `hunt` 2 cows or pigs, then `make_item` "cooked_beef" or "cooked_porkchop".
6. Before sunset: `build_shelter` (a 3x3 room with a door, 55 blocks; it uses what you have most of) where the player is, then `light_up_area` around it.
7. With a bed, place it inside (`place_block` "white_bed") and sleep when the player does; you sleep when they sleep. Without one, stay inside until morning. Don't wander in the dark without armor.

Skip steps the player already has covered (check the inventory first), and tell them what you're doing at each step.
