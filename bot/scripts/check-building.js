// In-game check of the Phase 8 building jobs. CHANGES THE WORLD, then puts it back: finds a level
// patch of grass near the bot, moves the bot there, records every block around it, places a chest,
// builds a shelter, lights the area, pillars up and bridges a trench, then restores every block.
// Gives the bot cobblestone, a door, a chest, torches and dirt, and takes back what's left.
// Run: npm run check:building (with the backend and bot running)
import { joinTester, sleep } from './tester.js'

async function within(ms, test) {
  for (let waited = 0; waited < ms; waited += 500) {
    if (test()) return true
    await sleep(500)
  }
  return test()
}

joinTester(async ({ client: t, companion: bot, give, say, command, waitFor, check, findPatch, saveArea }) => {
  const patch = findPatch({ radius: 4, height: 4 })
  if (!patch) {
    check('found room to test on', false, 'no mostly open, untouched grass within 40 blocks')
    return
  }
  const { center } = patch
  const at = (p) => `${p.x} ${p.y} ${p.z}`
  const saved = saveArea(center, 8, 4, 7)
  // Flatten the patch (if it isn't already) so every check starts from the same ground; restore()
  // puts the real terrain back.
  const flatten = () => {
    command(`/fill ${at(center.offset(-5, -1, -5))} ${at(center.offset(5, -1, 5))} grass_block`)
    command(`/fill ${at(center.offset(-5, 0, -5))} ${at(center.offset(5, 6, 5))} air`)
  }
  const restore = async () => { await saved(); if (patch.level) flatten() }
  if (patch.level) flatten()
  const returnTo = t.players[bot].entity.position.floored()
  console.log(`testing on the patch at ${at(center)}`)
  const block = (p) => t.blockAt(p)?.name
  const botAt = () => t.players[bot].entity.position

  try {
    command(`/tp ${bot} ${center.x + 0.5} ${center.y} ${center.z + 0.5}`)
    command(`/tp ClaudeTester ${at(center.offset(0, 8, 0))}`)
    // Otherwise it goes back to following its player between jobs and builds over there.
    say('stay here')
    await waitFor(/./, 15000)
    await sleep(1000)

    // One block, at coordinates.
    give('chest')
    const chestAt = center.offset(3, 0, 3)
    say(`place a chest at ${at(chestAt)}`)
    const placed = await waitFor(/Put down|couldn't|don't/, 30000)
    const chest = await within(3000, () => block(chestAt) === 'chest')
    check('places a chest where asked', chest, `${placed}; ${block(chestAt)} at ${at(chestAt)}`)

    // A shelter around where it stands.
    command(`/tp ${bot} ${center.x + 0.5} ${center.y} ${center.z + 0.5}`)
    give('cobblestone', 55)
    give('oak_door')
    await sleep(1000)
    say('build a shelter here out of cobblestone')
    const built = await waitFor(/Built the|built part|can't get enough|don't know/, 120000)
    // Block updates can reach the tester a moment after the bot's message.
    const doorCount = () => {
      let n = 0
      for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) if (block(center.offset(x, 0, z)) === 'oak_door') n++
      return n
    }
    await within(3000, () => doorCount() === 1)
    let walls = 0
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) for (let y = 0; y <= 2; y++) {
      if ((Math.abs(x) === 2 || Math.abs(z) === 2 || y === 2) && block(center.offset(x, y, z)) === 'cobblestone') walls++
    }
    const doors = doorCount()
    check('builds a shelter with walls, roof and door', /Built the shelter with a door/.test(built ?? '') && walls >= 50 && doors === 1,
      `${built}; ${walls} cobblestone of 55, ${doors} door`)

    // Torches on the dark ground around (block light is 0 on open grass, day or night).
    await restore()
    command(`/tp ${bot} ${center.x + 0.5} ${center.y} ${center.z + 0.5}`)
    give('torch', 8)
    await sleep(1500)
    say('light up the area within 6 blocks')
    const lit = await waitFor(/Placed \d+ torches|well lit|need torches/, 90000)
    let torches = 0
    for (let x = -8; x <= 8; x++) for (let z = -8; z <= 8; z++) for (let y = -4; y <= 4; y++) if (block(center.offset(x, y, z)) === 'torch') torches++
    check('lights the area with spaced-out torches', /Placed/.test(lit ?? '') && torches >= 2, `${lit}; ${torches} torches`)

    // Pillar up 3.
    await restore()
    const foot = center.offset(-3, 0, -3)
    command(`/tp ${bot} ${foot.x + 0.5} ${foot.y} ${foot.z + 0.5}`)
    give('dirt', 8)
    await sleep(1500)
    say('pillar up 3 blocks')
    const pillared = await waitFor(/Pillared|got \d+ blocks up|no blocks|in the way/, 40000)
    const rose = botAt().y - foot.y
    check('pillars up', /Pillared up 3/.test(pillared ?? '') && rose >= 2.9, `${pillared}; ${rose.toFixed(1)} blocks up`)

    // Bridge 4 east over a trench 3 deep.
    await restore()
    const start = center.offset(-3, 0, 0)
    command(`/fill ${at(start.offset(1, -3, 0))} ${at(start.offset(4, -1, 0))} air`)
    command(`/tp ${bot} ${start.x + 0.5} ${start.y} ${start.z + 0.5}`)
    await sleep(1500)
    say('bridge 4 blocks east')
    const bridged = await waitFor(/Bridged|got \d+ blocks|in the way|no blocks|Which way/, 60000)
    const deck = [1, 2, 3, 4].filter((i) => block(start.offset(i, -1, 0)) !== 'air').length
    check('bridges a gap', /Bridged 4 blocks east/.test(bridged ?? '') && deck === 4 && botAt().x >= start.x + 3.5,
      `${bridged}; ${deck}/4 deck blocks, bot at x ${botAt().x.toFixed(1)}`)
  } finally {
    say('stop')
    await sleep(2000)
    await saved()
    command(`/tp ${bot} ${at(returnTo)}`)
    await sleep(1000)
  }
})
