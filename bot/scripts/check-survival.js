// In-game check of the Phase 3 reflexes. CHANGES THE WORLD: gives the bot items, damages it,
// summons a husk next to it, and kills it once. Use a test world with cheats on.
// Run: npm run check:survival (with the backend and bot running)
import { joinTester, sleep } from './tester.js'

joinTester(async ({ companion: bot, say, command, waitFor, check, armor }) => {
  // Commands make the server print "[ClaudeTester: ...]" to operators; the bot must not answer those.
  command(`/give ${bot} bread 4`)
  check('commands get no reply', (await waitFor(/./, 4000)) === null)

  command(`/give ${bot} iron_chestplate`)
  command(`/give ${bot} iron_helmet`)
  await sleep(3000)
  check('puts on armor that lands in its inventory', armor().includes('iron_chestplate'), JSON.stringify(armor()))

  command(`/damage ${bot} 13`)
  await sleep(500)
  command(`/execute at ${bot} run summon husk ~4 ~1 ~`)
  const retreat = await waitFor(/Backing off|Running to you/, 8000)
  check('backs off when hurt with a mob near', retreat !== null, retreat)
  await sleep(3000)
  command('/kill @e[type=husk]')
  await sleep(2000)

  command(`/give ${bot} cobblestone 16`)
  await sleep(1000)
  command(`/kill ${bot}`)
  const death = await waitFor(/I died at/, 15000)
  check('says where it died', death !== null, death)
  await sleep(2000)
  say('get my stuff')
  const recovered = await waitFor(/Got my stuff|items are gone|can't find a way|despawned/, 120000)
  check('gets its items back', /Got my stuff/.test(recovered ?? ''), recovered)
})
