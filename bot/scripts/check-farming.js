// In-game check of the Phase 7 food and farming jobs. CHANGES THE WORLD, then puts it back: finds an
// open patch of grass near the bot, moves the bot there, records every block in the patch, makes
// farmland, ripe wheat and a small pond, and restores every recorded block at the end. Summoned
// animals are tagged and only tagged ones are killed. Gives the bot shears, a fishing rod, wheat,
// a furnace and coal. Use a test world with cheats on.
// Run: npm run check:farming (with the backend and bot running)
import { isManMade } from '../movements.js'
import { joinTester, sleep } from './tester.js'

const tag = 'farming_check'
// The patch: a square this many blocks from its centre, ground level and two blocks of air above.
const radius = 4

async function within(ms, test) {
  for (let waited = 0; waited < ms; waited += 500) {
    if (test()) return true
    await sleep(500)
  }
  return test()
}

joinTester(async ({ give, client: t, companion: bot, say, command, waitFor, check }) => {
  const me = () => t.players[bot]?.entity
  const grass = (name) => ['grass_block', 'dirt'].includes(name)
  // Somewhere to stand on natural ground (grass or dirt), with two blocks of air above.
  const standable = (p) => grass(t.blockAt(p.offset(0, -1, 0))?.name) &&
    t.blockAt(p)?.boundingBox === 'empty' && t.blockAt(p.offset(0, 1, 0))?.boundingBox === 'empty'
  // Nothing anyone built in or around the patch: no walls, paths, doors or floors to test on top of.
  function untouched(c) {
    for (let x = -radius - 2; x <= radius + 2; x++) {
      for (let z = -radius - 2; z <= radius + 2; z++) {
        for (let y = -2; y <= 3; y++) {
          if (isManMade(t.blockAt(c.offset(x, y, z))?.name ?? 'air')) return false
        }
      }
    }
    return true
  }
  // Cells (dx, dz from the centre) the checks use: the bot, the animals, the wheat row, the pond.
  const used = [[0, 0], [4, 0], [4, 2], [4, -2], [3, 3], [3, 0], [3, 2], [3, -3], [-3, -3], [-3, -2], [-3, -1]]
  const pond = [[-1, 2], [0, 2], [1, 2], [-1, 3], [0, 3], [1, 3], [-1, 4], [0, 4], [1, 4]]
  const aroundPond = []
  for (let x = -2; x <= 2; x++) for (let z = 1; z <= 5; z++) if (Math.abs(x) === 2 || z === 1 || z === 5) aroundPond.push([x, z])

  // A spot near the bot where all of that fits: the pond on grass, and room to till at least 6
  // blocks of grass beside it.
  function findField() {
    const start = me().position.floored()
    for (let r = 0; r <= 40; r += 2) {
      for (let dx = -r; dx <= r; dx += 2) {
        for (let dz = -r; dz <= r; dz += 2) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue // only the ring at this distance
          for (let dy = -4; dy <= 4; dy++) {
            const c = start.offset(dx, dy, dz)
            const at = ([x, z]) => c.offset(x, 0, z)
            if (!used.every((cell) => standable(at(cell)))) continue
            if (!pond.every((cell) => standable(at(cell)))) continue
            const tillable = aroundPond.filter((cell) => standable(at(cell)))
            if (tillable.length >= 6 && untouched(c)) return c
          }
        }
      }
    }
    return null
  }

  const field = findField()
  if (!field) {
    check('found an open patch of grass to test on', false, `none within 40 blocks of ${me().position.floored()}`)
    return
  }
  // Record the patch (ground and the two layers above), so everything can be put back.
  const saved = []
  for (let x = -radius - 1; x <= radius + 1; x++) {
    for (let z = -radius - 1; z <= radius + 1; z++) {
      for (let y = -2; y <= 1; y++) {
        const p = field.offset(x, y, z)
        saved.push([p, t.blockAt(p)?.name ?? 'air'])
      }
    }
  }
  const at = (p) => `${p.x} ${p.y} ${p.z}`
  const restore = async () => {
    command(`/kill @e[tag=${tag}]`)
    // Drops lying in the patch (wheat, seeds, wool) would otherwise be left behind.
    command(`/kill @e[type=item,x=${field.x},y=${field.y},z=${field.z},distance=..${radius + 4}]`)
    for (const [p, name] of saved) {
      if (t.blockAt(p)?.name !== name) { command(`/setblock ${at(p)} ${name}`); await sleep(60) }
    }
  }
  const returnTo = me().position.floored()
  console.log(`testing on the patch at ${at(field)}`)
  command(`/tp ${bot} ${field.x} ${field.y} ${field.z}`)
  command('/tp ClaudeTester ' + at(field.offset(0, 3, 0)))
  await sleep(2000)

  const tagged = (name) => Object.values(t.entities).filter((e) => e.name === name && e.position.distanceTo(field) <= radius + 10)
  const summon = (mob, dx, dz, nbt = '') => command(`/summon ${mob} ${at(field.offset(dx, 0, dz))} {Tags:["${tag}"]${nbt ? `,${nbt}` : ''}}`)

  try {
    // Hunting: three cows and a calf. One cow is hunted; the calf and the last two are left.
    for (const [dx, dz] of [[4, 0], [4, 2], [4, -2]]) summon('cow', dx, dz, 'NoAI:1b')
    summon('cow', 3, 3, 'NoAI:1b,Age:-24000')
    await sleep(1500)
    // Wild cows nearby count towards "the last two", so with them around it may hunt both.
    const calves = () => tagged('cow').filter((e) => e.metadata?.[16] === true).length
    say('hunt 2 cows')
    const hunted = await waitFor(/Hunted|only got|couldn't hunt/, 60000)
    await sleep(1000)
    const adultsLeft = Object.values(t.entities).filter((e) => e.name === 'cow' && e.metadata?.[16] !== true && e.position.distanceTo(field) <= 32).length
    check('hunts cows but spares the calf and the last two', /Hunted 2|only got 1/.test(hunted ?? '') && calves() === 1 && adultsLeft >= 2,
      `${hunted}; calf ${calves() ? 'alive' : 'gone'}, ${adultsLeft} grown cows left nearby`)

    // Hunting may have taken it after a wild cow; carry on from the patch.
    command(`/tp ${bot} ${field.x + 0.5} ${field.y} ${field.z + 0.5}`)
    await sleep(1000)

    // Cooking: with beef from the hunt and a furnace and coal given, it smelts.
    give('furnace')
    give('coal', 2)
    await sleep(1000)
    say('make 1 cooked beef')
    const cooked = await waitFor(/Made|couldn't make/, 90000)
    check('cooks the beef it hunted', /Made 1 cooked beef/.test(cooked ?? ''), cooked)
    await sleep(2000)

    // Breeding: the two cows left, fed wheat (no NoAI this time, so they can walk to each other).
    command(`/kill @e[tag=${tag}]`)
    summon('cow', 3, 0)
    summon('cow', 3, 2)
    give('wheat', 2)
    await sleep(1500)
    const adultCows = tagged('cow').length
    say('breed the cows')
    const bred = await waitFor(/Fed two|need/, 30000)
    const calf = await within(15000, () => Object.values(t.entities).filter((e) => e.name === 'cow' && e.position.distanceTo(field) <= radius + 10).length > adultCows)
    check('breeds two cows', /Fed two/.test(bred ?? '') && calf, `${bred}; ${calf ? 'a calf appeared' : 'no calf'}`)
    // The calf (if any) isn't tagged and stays: it's just a cow now.
    command(`/kill @e[tag=${tag}]`)
    await sleep(1000)

    // Shearing: a woolly sheep, with shears given.
    give('shears')
    summon('sheep', 3, -3, 'NoAI:1b')
    await sleep(1500)
    say('shear the sheep')
    const sheared = await waitFor(/Sheared|no woolly|can't shear/, 45000)
    check('shears a sheep', /Sheared/.test(sheared ?? ''), sheared)
    command(`/kill @e[tag=${tag}]`)

    // Harvesting: three rows of ripe wheat on farmland, harvested and replanted.
    const wheat = [[-3, -3], [-3, -2], [-3, -1]].map(([dx, dz]) => field.offset(dx, 0, dz))
    for (const p of wheat) {
      command(`/setblock ${at(p.offset(0, -1, 0))} farmland`)
      command(`/setblock ${at(p)} wheat[age=7]`)
    }
    await sleep(1500)
    say('harvest the wheat')
    const harvested = await waitFor(/Harvested|no ripe/, 60000)
    await sleep(1000)
    const replanted = wheat.filter((p) => t.blockAt(p)?.name === 'wheat' && Number(t.blockAt(p).getProperties().age) < 7).length
    check('harvests ripe wheat and replants it', /Harvested 3/.test(harvested ?? '') && replanted === 3, `${harvested}; ${replanted}/3 replanted`)

    // Planting: a pond in the middle of the patch; it tills the grass beside it and plants seeds.
    give('wheat_seeds', 4)
    command(`/fill ${at(field.offset(-1, -1, 2))} ${at(field.offset(1, -1, 4))} water`)
    await sleep(1500)
    say('plant 4 wheat')
    const planted = await waitFor(/Planted|couldn't plant|can't plant/, 90000)
    check('tills soil by water and plants', /Planted 4 wheat/.test(planted ?? ''), planted)

    // Fishing: in the same pond, with a rod given. Bites take 5 to 30 seconds.
    give('fishing_rod')
    await sleep(1000)
    say('catch 1 fish')
    const fished = await waitFor(/Caught|Nothing's biting|need/, 120000)
    check('fishes', /Caught/.test(fished ?? ''), fished)
  } finally {
    say('stop')
    await sleep(2000)
    await restore()
    command(`/tp ${bot} ${returnTo.x + 0.5} ${returnTo.y} ${returnTo.z + 0.5}`) // block centre: a corner can leave it stuck in a wall
    await sleep(1000)
  }
})
