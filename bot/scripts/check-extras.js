// In-game check of the last few features: replacing a worn-out pickaxe before it breaks, picking up
// what a killed mob drops, picking up items on request, and exploring. CHANGES THE WORLD a little:
// mines a few blocks of stone near the bot (like check:gathering), summons a frozen cow (killed for
// the test) and a few item stacks, and the bot walks 30 blocks north and back.
// Run: npm run check:extras (with the backend and bot running)
import { joinTester, sleep } from './tester.js'

const tag = 'extras_check'

async function within(ms, test) {
  for (let waited = 0; waited < ms; waited += 500) {
    if (test()) return true
    await sleep(500)
  }
  return test()
}

joinTester(async ({ client: t, companion: bot, give, say, command, waitFor, check, openSpot, findPatch }) => {
  say('stop following and stay where you are')
  await waitFor(/./, 15000)
  // Somewhere open, for the cow and the dropped items (nothing here changes blocks, so no restore).
  const patch = findPatch({ radius: 3, height: 3 })
  if (patch && !patch.level) {
    command(`/tp ${bot} ${patch.center.x + 0.5} ${patch.center.y} ${patch.center.z + 0.5}`)
    command(`/tp ClaudeTester ${patch.center.x + 0.5} ${patch.center.y + 4} ${patch.center.z + 0.5}`)
    await sleep(2000)
  }
  const itemsNear = (pos, range) => Object.values(t.entities).filter((e) => e.name === 'item' && e.position.distanceTo(pos) <= range)

  // A cow killed on request: its beef (cows always drop some) gets picked up.
  const cowAt = openSpot(4)
  if (cowAt) {
    command(`/execute at ${bot} run summon cow ${cowAt} {Tags:["${tag}"],NoAI:1b}`)
    await sleep(1500)
    const cow = t.nearestEntity((e) => e.name === 'cow')
    const spot = cow?.position.clone()
    say('kill that cow')
    await waitFor(/Got the cow|lost track|don't see/, 30000)
    await sleep(1000)
    const left = await within(12000, () => spot && itemsNear(spot, 4).length === 0)
    check('picks up what a mob it killed dropped', left, `${spot ? itemsNear(spot, 4).length : '?'} item stacks left where the cow died`)
  } else console.log('SKIP loot: no open ground near the bot')

  // Items lying around, picked up when asked.
  const dropAt = openSpot(4)
  if (dropAt) {
    command(`/execute at ${bot} run summon item ${dropAt} {Item:{id:"minecraft:oak_sapling",count:3}}`)
    await sleep(1500)
    say('pick up the items around you')
    const picked = await waitFor(/Picked up|nothing lying around/, 30000)
    check('picks up items when asked', /Picked up \d+ items/.test(picked ?? ''), picked)
  } else console.log('SKIP pick up: no open ground near the bot')

  // A stone pickaxe with 4 uses left (of 131): it makes a new one before the job wears it out. Clear
  // any pickaxes left from earlier runs first, or it has a spare and rightly doesn't bother.
  for (const pick of ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe']) command(`/clear ${bot} ${pick}`)
  give('stone_pickaxe[damage=127]')
  give('cobblestone', 3)
  give('stick', 2)
  give('crafting_table')
  await sleep(1500)
  say('get 2 cobblestone')
  const replaced = await waitFor(/nearly worn out|Got|couldn't|only got/, 90000)
  const done = /nearly worn out/.test(replaced ?? '') ? await waitFor(/Got|couldn't|only got/, 90000) : replaced
  check('replaces a nearly broken pickaxe first', /nearly worn out/.test(replaced ?? '') && /Got 2 cobblestone/.test(done ?? ''), `${replaced} / ${done}`)
  await sleep(1000)

  // A short exploring trip.
  say('explore 30 blocks north and tell me what you see')
  const report = await waitFor(/I (went|got) .*blocks north/, 150000)
  check('explores and reports back', /went 30 blocks north|got \d+ of 30 blocks north/.test(report ?? '') && /Saw /.test(report ?? ''), report)
  command(`/kill @e[tag=${tag}]`)
})
