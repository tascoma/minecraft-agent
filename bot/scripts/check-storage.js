// In-game check of the Phase 9 storage jobs. CHANGES THE WORLD, then puts it back: on a levelled
// patch near the bot it sets two chests with known contents, then has the bot look in them, answer
// where something is, sort them, put something away and take something out, reading the chests
// with /data after each. Everything in the patch is restored at the end (the chests go too).
// Doesn't check the automatic drop-off: that stores all the bot's own blocks, which the restore
// would then delete.
// Run: npm run check:storage (with the backend and bot running)
import { joinTester, sleep } from './tester.js'

joinTester(async ({ client: t, companion: bot, give, say, command, waitFor, check, findPatch, saveArea }) => {
  const patch = findPatch({ radius: 4, height: 3 })
  if (!patch) {
    check('found room to test on', false, 'no mostly open, untouched grass within 40 blocks')
    return
  }
  const { center } = patch
  const at = (p) => `${p.x} ${p.y} ${p.z}`
  const restore = saveArea(center, 6, 2, 4)
  const returnTo = t.players[bot].entity.position.floored()
  console.log(`testing on the patch at ${at(center)}`)

  // What's in a chest, read with /data: { name: count }.
  async function contents(pos) {
    const reply = new Promise((resolve) => {
      const timer = setTimeout(() => { t.off('messagestr', onMessage); resolve(null) }, 3000)
      function onMessage(text) {
        if (!text.includes('has the following block data') && !text.includes('Found no elements')) return
        clearTimeout(timer)
        t.off('messagestr', onMessage)
        resolve(text)
      }
      t.on('messagestr', onMessage)
    })
    command(`/data get block ${at(pos)} Items`)
    const text = await reply
    const items = {}
    for (const entry of (text ?? '').matchAll(/\{[^{}]*\}/g)) {
      const id = entry[0].match(/id: "minecraft:(\w+)"/)?.[1]
      const count = Number(entry[0].match(/count: (\d+)/)?.[1] ?? 1)
      if (id) items[id] = (items[id] ?? 0) + count
    }
    return items
  }
  const show = (items) => JSON.stringify(items)

  const a = center.offset(3, 0, -2)
  const b = center.offset(-3, 0, -2)
  try {
    command(`/fill ${at(center.offset(-5, -1, -5))} ${at(center.offset(5, -1, 5))} grass_block`)
    command(`/fill ${at(center.offset(-5, 0, -5))} ${at(center.offset(5, 4, 5))} air`)
    command(`/setblock ${at(a)} chest[facing=south]`)
    command(`/setblock ${at(b)} chest[facing=south]`)
    command(`/item replace block ${at(a)} container.0 with cobblestone 64`)
    command(`/item replace block ${at(a)} container.1 with dirt 5`)
    command(`/item replace block ${at(b)} container.0 with dirt 30`)
    command(`/item replace block ${at(b)} container.1 with iron_ingot 12`)
    // Stop it following its player first, or it walks back to them as soon as it's teleported.
    say('stop following and stay where you are')
    await waitFor(/./, 15000)
    command(`/tp ${bot} ${center.x + 0.5} ${center.y} ${center.z + 0.5}`)
    command(`/tp ClaudeTester ${at(center.offset(0, 6, 0))}`)
    await sleep(1500)
    // Everything below must happen at the patch: away from it, "put away" would fill a real chest.
    const there = t.players[bot]?.entity?.position.distanceTo(center.offset(0.5, 0, 0.5)) ?? Infinity
    if (there > 2) {
      check('the bot is on the test patch', false, `it's ${there.toFixed(0)} blocks away; stopping before touching any chests`)
      return
    }

    say('check the chests')
    const looked = await waitFor(/Looked in|no chest/, 60000)
    check('looks in the chests and lists what it saw', /Looked in 2 chests/.test(looked ?? '') && /iron ingot/.test(looked ?? ''), looked)

    say('where is my iron?')
    const where = await waitFor(/./, 30000)
    const named = (where ?? '').includes(String(b.x)) && (where ?? '').includes(String(b.z))
    check('remembers where the iron is', /12 iron/.test(where ?? '') && (named || /\d+ blocks? away/.test(where ?? '')), where)

    say('sort the chests')
    const sorted = await waitFor(/Sorted|already sorted|no chest|only one/, 90000)
    const [afterA, afterB] = [await contents(a), await contents(b)]
    check('sorts so each kind is in one chest', /Sorted/.test(sorted ?? '') && !afterA.dirt && afterB.dirt === 35 && afterA.cobblestone === 64,
      `${sorted}; A ${show(afterA)}, B ${show(afterB)}`)

    give('sand', 20)
    await sleep(1000)
    say('put away the sand')
    const stored = await waitFor(/Put away|couldn't put|no chest|don't have/, 60000)
    const sand = ((await contents(a)).sand ?? 0) + ((await contents(b)).sand ?? 0)
    // All its sand: the 20 given, plus any left over from an earlier run.
    const said = Number((stored ?? '').match(/Put away (\d+) sand/)?.[1] ?? 0)
    check('puts items away in a chest', said >= 20 && sand === said, `${stored}; ${sand} sand in the chests`)

    say('get 5 iron ingots from the chest')
    const took = await waitFor(/Got|no iron|no chest|full/, 60000)
    const iron = (await contents(b)).iron_ingot ?? 0
    check('takes items out of a chest', /Got 5 iron ingot/.test(took ?? '') && iron === 7, `${took}; ${iron} iron left in the chest`)
  } finally {
    say('stop')
    await sleep(1500)
    // Empty the chests before restoring, so their contents don't spill onto the ground.
    for (const p of [a, b]) command(`/data merge block ${at(p)} {Items:[]}`)
    await sleep(500)
    await restore()
    // The test chests are gone now; looking again makes the bot forget them.
    say('check the chests')
    const forgot = await waitFor(/Looked in|no chest/, 30000)
    check('forgets chests that are gone', /no chest/.test(forgot ?? ''), forgot)
    command(`/tp ${bot} ${at(returnTo)}`)
    await sleep(1000)
  }
})
