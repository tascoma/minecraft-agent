// In-game check of the Phase 6 combat reflexes. CHANGES THE WORLD: gives the bot a sword, heals it,
// and summons husks (they don't burn in daylight), a still creeper, a cow and a villager next to it.
// Everything it summons is tagged, and only tagged mobs are ever killed, so the world's own mobs are
// left alone. Still, use a test world with cheats on, in open ground (mobs summoned into walls suffocate).
// Run: npm run check:combat (with the backend and bot running)
import { joinTester, sleep } from './tester.js'

// Polls `test` every half second for up to `ms`; true as soon as it passes.
async function within(ms, test) {
  for (let waited = 0; waited < ms; waited += 500) {
    if (test()) return true
    await sleep(500)
  }
  return test()
}

const tag = 'combat_check'

joinTester(async ({ companion: bot, say, command, waitFor, check, count, distanceTo, openSpot, playersNear, seen, clearSeen, position, usingItem, offHand }) => {
  // Backing away from the creeper can land the bot somewhere awkward; later checks start from here.
  const backToStart = () => start && command(`/tp ${bot} ${start.x} ${start.y} ${start.z}`)
  // Summon a tagged mob next to the bot and wait until the tester can see it.
  async function summon(mob, distance, nbt = '', at = null) {
    const offset = at ?? openSpot(distance)
    if (!offset) {
      check(`room to summon a ${mob}`, false, `no open ground ${distance} blocks from the bot; move it somewhere open`)
      return false
    }
    const range = Math.max(10, distance + 4)
    const before = count(mob, range)
    const data = nbt ? `{Tags:["${tag}"],${nbt}}` : `{Tags:["${tag}"]}`
    command(`/execute at ${bot} run summon ${mob} ${offset} ${data}`)
    const appeared = await within(3000, () => count(mob, range) > before)
    if (!appeared) check(`summoned a ${mob}`, false, 'it never showed up; is the bot in a tight space?')
    return appeared && offset
  }
  const near = (mob) => count(mob, 10)
  const start = position()?.floored()
  const heal = () => command(`/effect give ${bot} instant_health 1 5`)
  command(`/give ${bot} iron_sword`)
  heal()
  await sleep(2000)

  // Fight back: a husk that can't move hits the bot from outside its defend range.
  if (await summon('husk', 8, 'NoAI:1b')) {
    command(`/damage ${bot} 2 minecraft:mob_attack by @e[tag=${tag},limit=1]`)
    check('fights back when hit', await within(20000, () => near('husk') === 0), `${near('husk')} husk(s) left`)
  }
  heal()
  await sleep(2000)

  // Defend: a husk walking up is attacked before it gets a hit in.
  if (await summon('husk', 4)) {
    check('attacks a hostile mob that comes close', await within(20000, () => near('husk') === 0), `${near('husk')} husk(s) left`)
  }
  heal()
  await sleep(2000)

  // Creeper: back away, don't hit it. NoAI so it can't blow up.
  // Listen before summoning: the bot reacts within a fraction of a second.
  const backingAway = waitFor(/Creeper! Backing away/, 8000)
  if (await summon('creeper', 2, 'NoAI:1b')) {
    const backing = await backingAway
    await sleep(2500)
    const gap = distanceTo('creeper')
    check('backs away from a creeper', backing !== null && gap > 4, `said ${JSON.stringify(backing)}, ${gap?.toFixed(1)} blocks away`)
    // It backs away up to creeperSafe (9) blocks and a bit more, so count a little wider.
    check('does not hit the creeper', count('creeper', 14) === 1)
  }
  command(`/kill @e[tag=${tag}]`)
  backToStart()
  await sleep(4000)

  // Ordered attack, and the line it never crosses.
  const villager = await summon('villager', 3, 'NoAI:1b')
  if (await summon('cow', 6, 'NoAI:1b')) {
    say('kill that cow')
    const cow = await waitFor(/Got the cow|lost track|don't see/, 30000)
    check('kills a mob when asked', /Got the cow/.test(cow ?? ''), cow)
  }
  if (villager) {
    say('attack the villager')
    await sleep(10000)
    check('never attacks a villager', near('villager') === 1)
  }
  command(`/kill @e[tag=${tag}]`)
  await sleep(2000)

  // A villager standing right where a husk is: the sword's sweep must not hit it.
  const spot = await summon('husk', 4, 'NoAI:1b')
  if (spot) {
    await summon('villager', 0, 'NoAI:1b', spot)
    command(`/damage ${bot} 1 minecraft:mob_attack by @e[tag=${tag},type=husk,limit=1]`)
    await within(20000, () => near('husk') === 0)
    await sleep(1000)
    check('kills a husk next to a villager without hurting the villager', near('husk') === 0 && near('villager') === 1,
      `${near('husk')} husk(s), ${near('villager')} villager(s) left`)
    command(`/kill @e[tag=${tag}]`)
    heal()
    await sleep(2000)
  }

  // Bow: a still husk out of reach hits the bot, which shoots it instead of walking over.
  command(`/give ${bot} bow`)
  command(`/give ${bot} arrow 32`)
  await sleep(1500)
  clearSeen()
  if (await summon('husk', 12, 'NoAI:1b')) {
    command(`/damage ${bot} 1 minecraft:mob_attack by @e[tag=${tag},type=husk,limit=1]`)
    const killed = await within(25000, () => near('husk') === 0 && count('husk', 16) === 0)
    check('shoots a mob that is out of reach', killed && seen('arrow'), `husk ${killed ? 'dead' : 'alive'}, arrows ${seen('arrow') ? 'seen' : 'none'}`)
    command(`/kill @e[tag=${tag}]`)
    heal()
    await sleep(2000)
  }

  // Shield: kept in the off-hand, and raised when an arrow flies at the bot.
  command(`/give ${bot} shield`)
  check('holds a shield in its off-hand', await within(5000, () => offHand() === 'shield'), offHand())
  const from = openSpot(6)
  if (!from) console.log('SKIP raises its shield at an incoming arrow: no open ground to shoot from')
  if (from) {
    const [dx, , dz] = from.split(' ').map((s) => Number(s.slice(1)) || 0)
    const length = Math.hypot(dx, dz)
    const motion = `[${(-dx / length * 1.5).toFixed(2)}d,0.1d,${(-dz / length * 1.5).toFixed(2)}d]`
    command(`/execute at ${bot} run summon arrow ~${dx} ~1.4 ~${dz} {Tags:["${tag}"],Motion:${motion}}`)
    check('raises its shield at an incoming arrow', await within(2000, usingItem))
    await sleep(1500)
    command(`/kill @e[tag=${tag}]`)
  }
  heal()
  await sleep(2000)

  // Guard: stands at its post, goes after a mob that comes near it, then comes back.
  say('guard this spot')
  const guarding = await waitFor(/Guarding/, 30000)
  check('starts guarding', guarding !== null, guarding)
  await sleep(1500)
  const postAt = position()
  if (guarding && await summon('husk', 10, 'NoAI:1b')) {
    const killed = await within(30000, () => near('husk') === 0 && count('husk', 16) === 0)
    const back = await within(20000, () => position()?.distanceTo(postAt) <= 3)
    check('fights a mob near its post and comes back', killed && back,
      `husk ${killed ? 'dead' : 'alive'}, ${position()?.distanceTo(postAt).toFixed(1)} blocks from post`)
    command(`/kill @e[tag=${tag}]`)
  }
  say('stop guarding and stay here')
  await sleep(4000)

  // Defend the companion: a still husk hits the player the bot plays with. Costs them half a heart,
  // healed straight after. Needs that player standing near the bot.
  const [player] = playersNear()
  if (!player) {
    console.log('SKIP defends its companion: no player near the bot')
    return
  }
  if (!(await summon('husk', 8, 'NoAI:1b'))) return
  command(`/damage ${player} 1 minecraft:mob_attack by @e[tag=${tag},type=husk,limit=1]`)
  command(`/effect give ${player} instant_health 1 0`)
  check(`defends ${player} when a mob hits them`, await within(20000, () => near('husk') === 0), `${near('husk')} husk(s) left`)
  command(`/kill @e[tag=${tag}]`)
})
