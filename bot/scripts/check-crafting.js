// In-game check of Phase 5 crafting and smelting. CHANGES THE WORLD: clears the bot's wood, stone and
// tools, then it chops trees, mines stone and places (then picks up) a crafting table and furnace.
// Needs trees and stone within 48 blocks of the bot.
// Run: npm run check:crafting (with the backend and bot running)
import { joinTester, sleep } from './tester.js'

const result = /^Made \d+|couldn't make|don't know what/

joinTester(async ({ companion: bot, say, command, waitFor, check }) => {
  // Start from nothing useful, so the bot has to work out the whole chain.
  for (const what of ['#minecraft:logs', '#minecraft:planks', 'stick', 'cobblestone', 'crafting_table', 'furnace',
    'wooden_pickaxe', 'stone_pickaxe', 'coal', 'charcoal', 'torch']) {
    command(`/clear ${bot} ${what}`)
  }
  await sleep(1000)

  say('make a stone pickaxe')
  const pickaxe = await waitFor(result, 420000)
  check('makes a stone pickaxe from nothing', /^Made 1 stone pickaxe/.test(pickaxe ?? ''), pickaxe)
  // `/clear <player> <item> 0` counts without removing anything.
  command(`/clear ${bot} crafting_table 0`)
  await sleep(1000)

  say('make 4 torches')
  const torches = await waitFor(result, 420000)
  check('makes torches (coal, or charcoal from a furnace)', /^Made 4 torches/.test(torches ?? ''), torches)

  // Smelting: hand it raw iron, so the furnace and smelting are tested without needing iron ore nearby.
  command(`/clear ${bot} furnace`)
  command(`/give ${bot} raw_iron 2`)
  await sleep(1000)
  say('make 2 iron ingots')
  const ingots = await waitFor(result, 420000)
  check('smelts iron (making and placing a furnace)', /^Made 2 iron ingots?/.test(ingots ?? ''), ingots)
  command(`/clear ${bot} furnace 0`)
  await sleep(1000)
})
