// In-game check of Phase 10: queued jobs, building and lighting a Nether portal, throwing an eye of
// ender, and villager trading. CHANGES THE WORLD, then puts it back: works on a levelled patch near
// the bot that's restored at the end, and the villager it trades with is summoned, tagged and
// removed. Gives the bot logs, obsidian, flint and steel, an eye of ender and emeralds.
// Doesn't go mining for diamonds (it digs a deep shaft) or through the portal (that builds a
// portal in the Nether that can't be put back).
// Run: npm run check:progression (with the backend and bot running)
import { joinTester, sleep } from './tester.js'

const tag = 'progression_check'

async function within(ms, test) {
  for (let waited = 0; waited < ms; waited += 500) {
    if (test()) return true
    await sleep(500)
  }
  return test()
}

joinTester(async ({ client: t, companion: bot, give, say, command, waitFor, check, findPatch, saveArea }) => {
  const patch = findPatch({ radius: 4, height: 3 })
  if (!patch) {
    check('found room to test on', false, 'no mostly open, untouched grass within 40 blocks')
    return
  }
  const { center } = patch
  const at = (p) => `${p.x} ${p.y} ${p.z}`
  const restore = saveArea(center, 7, 2, 7)
  const returnTo = t.players[bot].entity.position.floored()
  console.log(`testing on the patch at ${at(center)}`)
  const near = (name, range = 12) => Object.values(t.entities).filter((e) => e.name === name && e.position.distanceTo(center) <= range).length

  try {
    say('stop following and stay where you are')
    await waitFor(/./, 15000)
    command(`/fill ${at(center.offset(-5, -1, -5))} ${at(center.offset(5, -1, 5))} grass_block`)
    command(`/fill ${at(center.offset(-5, 0, -5))} ${at(center.offset(5, 6, 5))} air`)
    command(`/tp ${bot} ${center.x + 0.5} ${center.y} ${center.z + 0.5}`)
    // Above the bot, looking south: the portal goes in front of the player who asks.
    command(`/tp ClaudeTester ${center.x + 0.5} ${center.y + 4} ${center.z - 1.5} 0 30`)
    await sleep(2000)
    if ((t.players[bot]?.entity?.position.distanceTo(center.offset(0.5, 0, 0.5)) ?? 99) > 2) {
      check('the bot is on the test patch', false, 'stopping before building anything')
      return
    }

    // Two jobs in one reply run one after the other.
    give('oak_log', 2)
    await sleep(1000)
    say('make 4 sticks and then 1 crafting table')
    const first = await waitFor(/Made|couldn't make/, 60000)
    const second = await waitFor(/Made|couldn't make/, 60000)
    check('runs two jobs from one request in turn', /Made 4 sticks/.test(first ?? '') && /Made 1 crafting table/.test(second ?? ''), `${first} / ${second}`)

    // A Nether portal, built and lit.
    give('obsidian', 10)
    give('cobblestone', 4)
    give('flint_and_steel')
    await sleep(1000)
    say('build a nether portal')
    const built = await waitFor(/portal is lit|didn't light|need 10 obsidian|built part|in the way/, 120000)
    const lit = await within(3000, () => {
      let n = 0
      for (let x = -5; x <= 5; x++) for (let z = -5; z <= 5; z++) for (let y = 0; y <= 5; y++) if (t.blockAt(center.offset(x, y, z))?.name === 'nether_portal') n++
      return n >= 6
    })
    check('builds and lights a Nether portal', /portal is lit/.test(built ?? '') && lit, `${built}; ${lit ? 'portal blocks seen' : 'no portal blocks'}`)
    await restore()
    command(`/fill ${at(center.offset(-5, 0, -5))} ${at(center.offset(5, 6, 5))} air`)

    // An eye of ender: it says which way the stronghold is.
    give('ender_eye')
    await sleep(1000)
    say('throw an eye of ender')
    const eye = await waitFor(/The eye (flew|went)|lost sight|no eyes|only find/, 30000)
    check('throws an eye of ender and reads it', /The eye (flew|went)/.test(eye ?? ''), eye)

    // A farmer selling bread for an emerald.
    const offers = '{Recipes:[{buy:{id:"minecraft:emerald",count:1},sell:{id:"minecraft:bread",count:6},maxUses:12}]}'
    command(`/summon villager ${at(center.offset(3, 0, 0))} {Tags:["${tag}"],NoAI:1b,VillagerData:{profession:"minecraft:farmer",level:2,type:"minecraft:plains"},Offers:${offers}}`)
    await within(3000, () => near('villager', 6) > 0)
    say('what does the villager sell?')
    const listed = await waitFor(/offers|nothing to trade|no villager/, 45000)
    check('lists a villager\'s trades', /1 emerald → 6 bread/.test(listed ?? ''), listed)
    give('emerald', 2)
    await sleep(1000)
    say('buy 6 bread from the villager')
    const bought = await waitFor(/Traded|don't have enough|None of the villagers|no villager/, 45000)
    check('buys from a villager', /Traded for 6 bread/.test(bought ?? ''), bought)
  } finally {
    say('stop')
    await sleep(1500)
    command(`/kill @e[tag=${tag}]`)
    await restore()
    command(`/tp ${bot} ${returnTo.x + 0.5} ${returnTo.y} ${returnTo.z + 0.5}`) // block centre: a corner can leave it stuck in a wall
    await sleep(1000)
  }
})
