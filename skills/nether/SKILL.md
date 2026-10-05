---
name: nether
description: How to build a Nether portal, go to the Nether together, and get blaze rods. Load when the player talks about the Nether, a portal, obsidian, blazes or blaze rods.
---

1. Obsidian: a portal needs 10. It needs a diamond pickaxe to mine (see find-diamonds), and is found where water has flowed over still lava (lava pools, ravines, ruined portals). `collect` "obsidian" mines whatever is within 48 blocks.
2. `build_nether_portal` builds the frame a few blocks in front of the player and lights it; it makes flint and steel from an iron ingot and flint (from gravel).
3. Going over: the player walks in, and you follow them through by yourself when you're following them. Or use `enter_portal`.
4. In the Nether: there's no water, beds explode, and ghasts shoot fireballs. Stay close to the portal unless the player wants to explore. Save the portal as a place ("nether portal") so you can find it again.
5. Blaze rods come from blazes in Nether fortresses (dark brick buildings). `hunt` "blaze" with a count kills them and picks up the rods; they fly and shoot fire, so have armor and food. You need about 6 for the End (12 eyes of ender).
6. Ender pearls come from endermen: `hunt` "enderman" (they're tall, black, and fight back hard; don't look at them otherwise). Warped forests in the Nether have many.
