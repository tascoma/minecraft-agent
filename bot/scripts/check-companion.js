// In-game check of Phase 11: long-term notes, the journal of what happened, and tips. The tips need
// the player the bot plays with standing near it (they're about that player); without them those
// checks are skipped. CHANGES THE WORLD a little: puts a diamond ore block next to the player for
// a moment (put back straight after) and summons a creeper that can't move or explode (tagged and
// removed). Saves a note in the world's memory and then forgets it.
// Run: npm run check:companion (with the backend and bot running)
import { joinTester, sleep } from './tester.js'

const tag = 'companion_check'

joinTester(async ({ client: t, companion: bot, give, say, command, waitFor, check, playersNear }) => {
  // Notes: kept across sessions, shown to the agent every message.
  say('please remember that my favourite block is copper')
  await waitFor(/./, 30000)
  await sleep(1000)
  say('what is my favourite block?')
  const recalled = await waitFor(/./, 30000)
  check('remembers a note', /copper/i.test(recalled ?? ''), recalled)
  say('forget what my favourite block is')
  const forgot = await waitFor(/./, 30000)
  check('forgets a note when asked', forgot !== null, forgot)

  // The journal: a finished job is recorded, so the agent knows how it went.
  give('oak_log', 1)
  await sleep(1000)
  say('make 4 sticks')
  const made = await waitFor(/Made|couldn't make/, 60000)
  await sleep(1500)
  say('did the sticks work out?')
  const told = await waitFor(/./, 30000)
  check('knows how a finished job went', /Made 4 sticks/.test(made ?? '') && /stick/i.test(told ?? '') && !/not sure|don't know/i.test(told ?? ''), `${made} / ${told}`)

  // Tips about the player the bot plays with.
  const [player] = playersNear(16)
  if (!player) {
    console.log('SKIP tips: the player the bot plays with is not near it')
    return
  }
  const p = t.players[player].entity.position.floored()
  const awayFromBot = t.players[bot].entity.position.x > p.x ? -3 : 3

  command(`/summon creeper ${p.x + awayFromBot} ${p.y} ${p.z} {Tags:["${tag}"],NoAI:1b}`)
  const warned = await waitFor(/creeper right by you/i, 8000)
  check('warns the player about a creeper next to them', warned !== null, warned)
  command(`/kill @e[tag=${tag}]`)

  // Diamond ore in plain view next to the player, then the original block back. Tips are spaced
  // 90 seconds apart, and the player may have moved meanwhile, so look where they are after waiting.
  await sleep(90_000)
  const now = t.players[player]?.entity?.position.floored() ?? p
  const spot = now.offset(2, -1, 0)
  const original = t.blockAt(spot)
  const props = Object.entries(original?.getProperties() ?? {})
  const state = !original ? 'air' : props.length ? `${original.name}[${props.map(([k, v]) => `${k}=${v}`).join(',')}]` : original.name
  command(`/setblock ${spot.x} ${spot.y} ${spot.z} diamond_ore`)
  const ore = await waitFor(/I can see diamond ore/, 8000)
  command(`/setblock ${spot.x} ${spot.y} ${spot.z} ${state}`)
  check('points out diamonds in view', ore !== null, ore)
})
