// In-game check of Phase 4 gathering. CHANGES THE WORLD: the bot chops trees and mines stone
// near where it stands (never within 16 blocks of a saved place), and its pickaxes are cleared.
// Run: npm run check:gathering (with the backend and bot running, trees and stone nearby)
import { joinTester, sleep } from './tester.js'

const result = /^Got \d+|only got|couldn't get|don't know how|need a/

joinTester(async ({ companion: bot, say, command, waitFor, check }) => {
  command(`/clear ${bot} stone_pickaxe`)
  command(`/clear ${bot} wooden_pickaxe`)
  await sleep(1000)

  say('get 3 logs')
  const logs = await waitFor(result, 180000)
  check('chops logs', /^Got 3 logs/.test(logs ?? ''), logs)

  say('get 4 cobblestone')
  const noPick = await waitFor(result, 60000)
  check('says it needs a pickaxe', /need a pickaxe/.test(noPick ?? ''), noPick)

  command(`/give ${bot} stone_pickaxe`)
  await sleep(1000)
  say('get 20 cobblestone')
  const progress = await waitFor(/so far|^Got|only got|couldn't/, 150000)
  check('reports progress halfway', /so far/.test(progress ?? ''), progress)
  say('stop')
  check('stop cancels the job quietly', (await waitFor(result, 8000)) === null)

  // Spectators are invisible to other players, so become visible for the hand-over.
  command('/gamemode creative ClaudeTester')
  command(`/tp ClaudeTester ${bot}`)
  await sleep(1000)
  say('give me 2 cobblestone')
  const given = await waitFor(/Here's|don't have|can't/, 60000)
  check('hands items over', /Here's 2 cobblestone/.test(given ?? ''), given)
  await sleep(2000)
  command('/gamemode spectator ClaudeTester')
})
