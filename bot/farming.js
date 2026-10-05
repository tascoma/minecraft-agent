// Food and farming jobs: hunt animals and pick up the drops, harvest and replant crops, till and
// plant a new field near water, breed animals, fish, and shear sheep. Each runs as a job (see
// tasks.js) and reports in chat. Hunting also feeds crafting, so "make cooked beef" works from nothing.
import { createRequire } from 'node:module'
import pathfinderPkg from 'mineflayer-pathfinder'
import { startTask } from './tasks.js'
import { goWithin } from './walk.js'

const require = createRequire(import.meta.url)
const { Vec3 } = require('vec3')
const { goals } = pathfinderPkg

const maxCount = 64
// How far to look for animals, crops and water, in blocks.
const searchRadius = 32
// Leave at least this many adults of a kind nearby, so they can still breed.
const keepForBreeding = 2
// Give up after this many animals in a row couldn't be caught or this many blocks couldn't be worked.
const maxFailures = 3
// Farmland needs water within this many blocks (horizontally, same level) to stay wet.
const waterReach = 4
// Animals can be bred again after 5 minutes.
const breedCooldownMs = 5 * 60_000
// Wait at most this long for a bite before reeling in and casting again.
const fishBiteMs = 45_000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pretty = (name) => name.replaceAll('_', ' ')
const missing = (message) => Object.assign(new Error(message), { name: 'Missing' })

// Which animals drop an item, for hunting it.
const animalDrops = {
  beef: ['cow', 'mooshroom'],
  leather: ['cow', 'mooshroom'],
  porkchop: ['pig'],
  chicken: ['chicken'],
  feather: ['chicken'],
  mutton: ['sheep'],
  rabbit: ['rabbit'],
  rabbit_hide: ['rabbit'],
}
export const animalsFor = (item) => animalDrops[item] ?? null

// What each animal eats when bred, best first.
export const breedingFood = {
  cow: ['wheat'], mooshroom: ['wheat'], sheep: ['wheat'], goat: ['wheat'],
  pig: ['carrot', 'potato', 'beetroot'],
  chicken: ['wheat_seeds', 'beetroot_seeds', 'melon_seeds', 'pumpkin_seeds'],
  rabbit: ['carrot', 'dandelion'],
}

// Crops: the block, what replants it, and its age when ripe.
export const crops = {
  wheat: { seed: 'wheat_seeds', ripe: 7 },
  carrots: { seed: 'carrot', ripe: 7 },
  potatoes: { seed: 'potato', ripe: 7 },
  beetroots: { seed: 'beetroot_seeds', ripe: 3 },
}

/** "Cows", "the chicken" -> "cow", "chicken". Sheep stay sheep. */
export function animalName(spoken) {
  const name = spoken?.toLowerCase().trim().replace(/^(the|a|an|some)\s+/, '').replaceAll(' ', '_')
  if (!name) return null
  if (breedingFood[name] || name === 'sheep') return name
  return name.replace(/s$/, '')
}

/** "carrot", "potatoes", "wheat seeds" -> the crop block name ("carrots", "potatoes", "wheat"). */
export function cropName(spoken) {
  const name = spoken?.toLowerCase().trim().replaceAll(' ', '_')
  if (!name) return null
  if (crops[name]) return name
  const bySeed = Object.keys(crops).find((c) => crops[c].seed === name)
  if (bySeed) return bySeed
  return Object.keys(crops).find((c) => c.startsWith(name.replace(/(e?s)$/, ''))) ?? null
}

/** True for a crop block that's ready to harvest. */
export function isRipe(block) {
  const crop = crops[block?.name]
  // Block properties come back as strings ("7").
  return Boolean(crop) && Number(block.getProperties().age) >= crop.ripe
}

// Entity metadata (Minecraft 1.21): index 16 is "is baby" for animals; for sheep, bit 0x10 of
// index 17 is "sheared".
export const isBaby = (entity) => entity.metadata?.[16] === true
export const isSheared = (entity) => Boolean((entity.metadata?.[17] ?? 0) & 0x10)

export function installFarming(bot, { say, log, survival, combat, gathering, crafting, resume }) {
  const have = (name) => bot.inventory.items().filter((i) => i.name === name).reduce((n, i) => n + i.count, 0)
  const holdingAny = (names) => names.find((n) => have(n) > 0) ?? null
  const me = () => bot.entity.position
  // Jobs that pick things up can't work with no free slot, and would otherwise fail confusingly
  // ("I have no seeds" right after being handed some that landed on the floor).
  function inventoryFull() {
    if (bot.inventory.emptySlotCount() > 0) return false
    say("My inventory is full, so I can't pick anything up. Take some things off me or let me drop some.")
    return true
  }

  async function equip(name) {
    if (bot.heldItem?.name === name) return
    const item = bot.inventory.items().find((i) => i.name === name)
    if (!item) throw missing(`I have no ${pretty(name)}`)
    await bot.equip(item, 'hand')
  }

  // Walk somewhere, waiting out any reflex that interrupts (a fight, eating, backing off) and
  // trying again, up to three times. Throws if the walk itself fails.
  async function walk(task, goal, isThere, ms = 30_000) {
    for (let attempt = 1; ; attempt++) {
      if (isThere()) return
      try {
        await goWithin(bot, goal(), ms)
        return
      } catch (err) {
        if (task.cancelled || !survival.busy() || attempt >= 3) throw err
        await waitForReflexes(task)
      }
    }
  }
  const walkNear = (task, pos, range) =>
    walk(task, () => new goals.GoalNear(pos.x, pos.y, pos.z, range), () => me().distanceTo(pos) <= range)
  const walkToEntity = (task, entity, range) =>
    walk(task, () => new goals.GoalFollow(entity, range), () => me().distanceTo(entity.position) <= range)

  // Wait out a survival or combat reflex (eating, backing off, a fight) before the next step.
  async function waitForReflexes(task) {
    while (!task.cancelled && survival.busy()) await sleep(500)
  }

  // --- Hunting ------------------------------------------------------------
  const adults = (kinds) => Object.values(bot.entities).filter((e) => kinds.includes(e.name) && !isBaby(e))

  // The nearest adult of `kinds` that can be hunted without wiping out the herd, or null.
  function nextAnimal(kinds) {
    const all = adults(kinds)
    const candidates = all
      .filter((e) => e.position.distanceTo(me()) <= searchRadius)
      .filter((e) => all.filter((o) => o.name === e.name && o.position.distanceTo(e.position) <= searchRadius).length > keepForBreeding)
    return candidates.sort((a, b) => a.position.distanceTo(me()) - b.position.distanceTo(me()))[0] ?? null
  }

  // Kill animals of `kinds` until `enough()` says stop. Returns { kills, reason }.
  async function huntUntil(task, kinds, enough) {
    let kills = 0
    let failures = 0
    while (!task.cancelled && !enough(kills)) {
      await waitForReflexes(task)
      if (task.cancelled) break
      const animal = nextAnimal(kinds)
      if (!animal) {
        const names = kinds.map((k) => (k === 'sheep' ? k : `${k}s`)).join(' or ')
        const reason = adults(kinds).length > 0
          ? `the only ${names} nearby are the last ${keepForBreeding}, and I'm leaving them to breed`
          : `there are no ${names} within ${searchRadius} blocks`
        return { kills, reason }
      }
      try {
        await walkToEntity(task, animal, 6)
      } catch {
        if (task.cancelled) break
      }
      const lastSeen = animal.position.clone()
      const killed = await combat.kill(animal)
      if (task.cancelled) break
      if (!killed) {
        if (++failures >= maxFailures) return { kills, reason: `the ${pretty(animal.name)}s keep getting away` }
        continue
      }
      failures = 0
      kills++
      await gathering.pickUpDrops(animal.position ?? lastSeen)
    }
    return { kills, reason: null }
  }

  function hunt({ target, count }) {
    const animal = animalName(target)
    if (!animal || !bot.registry.entitiesByName[animal]) {
      say(`I don't know what "${target}" is.`)
      return
    }
    count = Math.max(1, Math.min(count ?? 1, maxCount))
    startTask(`hunting ${count} ${animal}`, async (task) => {
      if (inventoryFull()) return
      const { kills, reason } = await huntUntil(task, [animal], (n) => {
        task.progress = `${n}/${count}`
        return n >= count
      })
      if (task.cancelled) return
      const name = (n) => (n === 1 || animal === 'sheep' ? animal : `${animal}s`)
      if (kills >= count) say(`Hunted ${kills} ${name(kills)} and picked up what they dropped.`)
      else if (kills > 0) say(`I only got ${kills} ${name(kills)}: ${reason}.`)
      else say(`I couldn't hunt any: ${reason}.`)
    }, { log, onCancel: () => bot.pathfinder.setGoal(null), onEnd: resume })
  }

  // For crafting: hunt until the bot holds `n` more of `item` (e.g. beef for cooked beef).
  crafting.setHunter({
    drops: (item) => Boolean(animalsFor(item)),
    async hunt(task, item, n) {
      const start = have(item)
      // Each animal drops one to three, so stop after a sensible number of kills either way.
      const { reason } = await huntUntil(task, animalsFor(item), (kills) => have(item) - start >= n || kills >= n + 3)
      if (have(item) - start < n && !task.cancelled) throw missing(`I couldn't hunt enough for ${pretty(item)}: ${reason ?? 'not enough dropped'}`)
    },
  })

  // --- Harvesting and planting --------------------------------------------
  const cropIds = (names) => names.map((c) => bot.registry.blocksByName[c].id)

  // Put a seed on the farmland at `pos`. Returns true if a crop is there afterwards.
  async function plantOn(farmland, seed) {
    if (bot.blockAt(farmland.position.offset(0, 1, 0))?.name !== 'air') return false
    await equip(seed)
    await bot.placeBlock(farmland, new Vec3(0, 1, 0)).catch(() => {}) // the crop isn't a "block placed" update on every version
    await sleep(150)
    return Boolean(crops[bot.blockAt(farmland.position.offset(0, 1, 0))?.name])
  }

  function harvest({ target }) {
    const only = target ? cropName(target) : null
    if (target && !only) {
      say(`I don't know how to harvest "${target}". I can do wheat, carrots, potatoes and beetroots.`)
      return
    }
    const names = only ? [only] : Object.keys(crops)
    startTask(`harvesting ${only ? pretty(only) : 'crops'}`, async (task) => {
      if (inventoryFull()) return
      let harvested = 0
      let replanted = 0
      let failures = 0
      const skipped = new Set()
      while (!task.cancelled && harvested < maxCount) {
        await waitForReflexes(task)
        const [pos] = bot.findBlocks({
          matching: cropIds(names),
          maxDistance: searchRadius,
          count: 1,
          useExtraInfo: (b) => isRipe(b) && !skipped.has(b.position.toString()),
        })
        if (!pos) break
        const block = bot.blockAt(pos)
        try {
          await walkNear(task, pos, 2)
          if (task.cancelled) break
          await bot.dig(block)
          harvested++
          task.progress = `${harvested}`
          await gathering.pickUpDrops(pos)
          const farmland = bot.blockAt(pos.offset(0, -1, 0))
          const seed = crops[block.name].seed
          if (farmland?.name === 'farmland' && have(seed) > 0 && await plantOn(farmland, seed)) replanted++
          failures = 0
        } catch (err) {
          if (task.cancelled) break
          if (survival.busy()) continue
          log('WARN', `couldn't harvest ${block.name} at ${pos}: ${err.message}`)
          skipped.add(pos.toString())
          if (++failures >= maxFailures) break
        }
      }
      if (task.cancelled) return
      if (harvested === 0) say(`There are no ripe ${only ? pretty(only) : 'crops'} within ${searchRadius} blocks.`)
      else say(`Harvested ${harvested} and replanted ${replanted}.`)
    }, { log, onCancel: () => bot.pathfinder.setGoal(null), onEnd: resume })
  }

  // Tillable blocks with air above and water close enough to keep the farmland wet.
  function fieldSpots(limit) {
    const water = bot.findBlocks({ matching: bot.registry.blocksByName.water.id, maxDistance: searchRadius, count: 400 })
    if (water.length === 0) return []
    const tillable = ['dirt', 'grass_block', 'coarse_dirt', 'dirt_path'].map((n) => bot.registry.blocksByName[n].id)
    const wet = (pos) => water.some((w) => w.y === pos.y && Math.abs(w.x - pos.x) <= waterReach && Math.abs(w.z - pos.z) <= waterReach)
    return bot.findBlocks({
      matching: tillable,
      maxDistance: 24,
      count: 400,
      useExtraInfo: (b) => bot.blockAt(b.position.offset(0, 1, 0))?.name === 'air' && wet(b.position),
    }).slice(0, limit)
  }

  // Empty farmland with air above, to plant before tilling anything new.
  function emptyFarmland(limit) {
    return bot.findBlocks({
      matching: bot.registry.blocksByName.farmland.id,
      maxDistance: searchRadius,
      count: limit,
      useExtraInfo: (b) => bot.blockAt(b.position.offset(0, 1, 0))?.name === 'air',
    })
  }

  function plant({ target, count }) {
    const crop = cropName(target ?? 'wheat')
    if (!crop) {
      say(`I don't know how to plant "${target}". I can do wheat, carrots, potatoes and beetroots.`)
      return
    }
    const seed = crops[crop].seed
    count = Math.max(1, Math.min(count ?? 16, maxCount))
    startTask(`planting ${count} ${pretty(crop)}`, async (task) => {
      if (inventoryFull()) return
      try {
        // Wheat seeds come from breaking grass (about one in eight drops one); carrots and potatoes
        // have to be found or given.
        if (have(seed) < count && seed === 'wheat_seeds') {
          say('Getting some seeds from the grass first.')
          const grass = ['short_grass', 'tall_grass'].map((n) => bot.registry.blocksByName[n]?.id).filter((id) => id != null)
          const target = { blockIds: grass, items: new Set(['wheat_seeds']), label: 'wheat seeds' }
          await gathering.gather(task, target, Math.min(count, 8) - have(seed))
        }
        if (have(seed) === 0) throw missing(`I have no ${pretty(seed)}${seed === 'wheat_seeds' ? ' and found none in the grass' : ''}`)
        if (!bot.inventory.items().some((i) => i.name.endsWith('_hoe'))) await crafting.obtainItem(task, 'wooden_hoe')
      } catch (err) {
        if (!task.cancelled) say(`I can't plant ${pretty(crop)}: ${err.message}.`)
        return
      }
      let planted = 0
      let failures = 0
      const skipped = new Set()
      while (!task.cancelled && planted < count && have(seed) > 0) {
        await waitForReflexes(task)
        const free = emptyFarmland(20).filter((p) => !skipped.has(p.toString()))
        const spot = free[0] ?? fieldSpots(40).find((p) => !skipped.has(p.toString()))
        if (!spot) break
        try {
          await walkNear(task, spot, 3)
          if (task.cancelled) break
          let ground = bot.blockAt(spot)
          if (ground.name !== 'farmland') {
            await equip(bot.inventory.items().find((i) => i.name.endsWith('_hoe')).name)
            await bot.activateBlock(ground)
            await sleep(200)
            ground = bot.blockAt(spot)
            if (ground.name !== 'farmland') throw new Error(`${ground.name} didn't turn into farmland`)
          }
          if (!await plantOn(ground, seed)) throw new Error('the seed didn\'t take')
          planted++
          task.progress = `${planted}/${count}`
          failures = 0
        } catch (err) {
          if (task.cancelled) break
          if (survival.busy()) continue
          log('WARN', `couldn't plant at ${spot}: ${err.message}`)
          skipped.add(spot.toString())
          if (++failures >= maxFailures) break
        }
      }
      if (task.cancelled) return
      if (planted === 0) say(`I couldn't plant any ${pretty(crop)}: there's no dirt next to water within 24 blocks I can farm.`)
      else if (planted < count) say(`Planted ${planted} ${pretty(crop)}${have(seed) === 0 ? `; I ran out of ${pretty(seed)}` : ''}.`)
      else say(`Planted ${planted} ${pretty(crop)}.`)
    }, { log, onCancel: () => bot.pathfinder.setGoal(null), onEnd: resume })
  }

  // --- Breeding -----------------------------------------------------------
  // Animal id -> when the bot last fed it, so it doesn't waste food on one that can't breed yet.
  const fedAt = new Map()

  function breed({ target }) {
    const animal = animalName(target)
    const foods = breedingFood[animal]
    if (!foods) {
      say(`I don't know how to breed ${target ? pretty(target) : 'that'}. I can do cows, sheep, pigs, chickens, goats and rabbits.`)
      return
    }
    startTask(`breeding ${animal}`, async (task) => {
      const food = holdingAny(foods)
      if (!food || have(food) < 2) {
        say(`I need 2 ${pretty(foods[0])} to breed ${animal === 'sheep' ? 'sheep' : `${animal}s`}.`)
        return
      }
      const ready = adults([animal])
        .filter((e) => e.position.distanceTo(me()) <= searchRadius && Date.now() - (fedAt.get(e.id) ?? 0) > breedCooldownMs)
        .sort((a, b) => a.position.distanceTo(me()) - b.position.distanceTo(me()))
      if (ready.length < 2) {
        say(`I need two grown ${animal === 'sheep' ? 'sheep' : `${animal}s`} nearby that haven't bred in the last 5 minutes.`)
        return
      }
      const pair = [ready[0], ready.slice(1).sort((a, b) => a.position.distanceTo(ready[0].position) - b.position.distanceTo(ready[0].position))[0]]
      for (const e of pair) {
        await waitForReflexes(task)
        if (task.cancelled) return
        try {
          await walkToEntity(task, e, 2)
          await equip(food)
          await bot.lookAt(e.position.offset(0, (e.height ?? 1) / 2, 0), true)
          await bot.activateEntity(e)
          fedAt.set(e.id, Date.now())
        } catch (err) {
          if (task.cancelled) return
          say(`I couldn't reach the ${pretty(animal)} to feed it.`)
          return
        }
      }
      say(`Fed two ${animal === 'sheep' ? 'sheep' : `${animal}s`} ${pretty(food)}; a baby should appear in a moment.`)
    }, { log, onCancel: () => bot.pathfinder.setGoal(null), onEnd: resume })
  }

  // --- Fishing ------------------------------------------------------------
  // A water block with open water around and air above, so the bobber lands in it.
  function fishingSpot() {
    const waterId = bot.registry.blocksByName.water.id
    const open = (pos) => bot.blockAt(pos.offset(0, 1, 0))?.name === 'air'
    return bot.findBlocks({
      matching: waterId,
      maxDistance: 24,
      count: 200,
      useExtraInfo: (b) => open(b.position) && [[1, 0], [-1, 0], [0, 1], [0, -1]]
        .every(([dx, dz]) => bot.blockAt(b.position.offset(dx, 0, dz))?.name === 'water'),
    })[0] ?? null
  }

  function fish({ count }) {
    count = Math.max(1, Math.min(count ?? 5, maxCount))
    // True while the line is out, so cancelling reels it in (using the rod otherwise would cast it).
    let casting = false
    startTask(`fishing for ${count}`, async (task) => {
      if (inventoryFull()) return
      // A rod needs string, which only comes from spiders, so don't start chopping wood without it.
      if (have('fishing_rod') === 0 && have('string') < 2) {
        say('I need a fishing rod, or 2 string to make one (spiders drop string).')
        return
      }
      try {
        await crafting.obtainItem(task, 'fishing_rod')
      } catch (err) {
        if (!task.cancelled) say(`I couldn't make a fishing rod: ${err.message}.`)
        return
      }
      const spot = fishingSpot()
      if (!spot) {
        say('I need open water within 24 blocks to fish.')
        return
      }
      let caught = 0
      let misses = 0
      try {
        await walkNear(task, spot.offset(0, 1, 0), 4)
      } catch {
        if (!task.cancelled) say("I can't get close enough to the water.")
        return
      }
      while (!task.cancelled && caught < count && misses < maxFailures) {
        await waitForReflexes(task)
        if (task.cancelled) break
        await equip('fishing_rod')
        await bot.lookAt(spot.offset(0.5, 1, 0.5), true)
        casting = true
        const bite = bot.fish().then(() => true, (err) => { log('WARN', `fishing: ${err.message}`); return false })
        const timeout = sleep(fishBiteMs).then(() => null)
        const result = await Promise.race([bite, timeout])
        if (result === null) {
          bot.activateItem() // reel in the line and cast again
          casting = false
          misses++
          continue
        }
        casting = false
        if (result) {
          caught++
          misses = 0
          task.progress = `${caught}/${count}`
          await sleep(1000) // the catch flies to the bot
        } else misses++
      }
      if (task.cancelled) return
      say(caught >= count ? `Caught ${caught} things.` : caught > 0 ? `Caught ${caught}; they stopped biting.` : "Nothing's biting here.")
    }, {
      log,
      onCancel() { bot.pathfinder.setGoal(null); if (casting) bot.activateItem() },
      onEnd: resume,
    })
  }

  // --- Shearing -----------------------------------------------------------
  function shear({ count }) {
    count = Math.max(1, Math.min(count ?? 64, maxCount))
    startTask(`shearing ${count} sheep`, async (task) => {
      if (inventoryFull()) return
      try {
        await crafting.obtainItem(task, 'shears')
      } catch (err) {
        if (!task.cancelled) say(`I can't shear without shears: ${err.message}.`)
        return
      }
      let sheared = 0
      let failures = 0
      const skipped = new Set()
      while (!task.cancelled && sheared < count) {
        await waitForReflexes(task)
        if (task.cancelled) break
        const sheep = adults(['sheep'])
          .filter((e) => !isSheared(e) && !skipped.has(e.id) && e.position.distanceTo(me()) <= searchRadius)
          .sort((a, b) => a.position.distanceTo(me()) - b.position.distanceTo(me()))[0]
        if (!sheep) break
        try {
          await walkToEntity(task, sheep, 2)
          await equip('shears')
          await bot.lookAt(sheep.position.offset(0, 0.7, 0), true)
          await bot.activateEntity(sheep)
          await sleep(300)
          await gathering.pickUpDrops(sheep.position)
          sheared++
          task.progress = `${sheared}/${count}`
          failures = 0
        } catch (err) {
          if (task.cancelled) break
          skipped.add(sheep.id)
          if (++failures >= maxFailures) break
        }
      }
      if (task.cancelled) return
      say(sheared > 0 ? `Sheared ${sheared} sheep.` : `There are no woolly sheep within ${searchRadius} blocks.`)
    }, { log, onCancel: () => bot.pathfinder.setGoal(null), onEnd: resume })
  }

  return { hunt, harvest, plant, breed, fish, shear }
}
