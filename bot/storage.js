// Base and storage: put items away in chests, take them out, look in chests, sort them, and drop a
// full inventory off at the base by itself. Every chest the bot opens is remembered, here and in the
// backend (per world), so it knows where things are without looking again.
import { createRequire } from 'node:module'
import pathfinderPkg from 'mineflayer-pathfinder'
import { protectedPlaces } from './movements.js'
import { currentTask, startTask } from './tasks.js'
import { goWithin } from './walk.js'

const require = createRequire(import.meta.url)
const { Vec3 } = require('vec3')
const { goals } = pathfinderPkg

const containers = ['chest', 'trapped_chest', 'barrel']
// Look for chests this far from the bot, or this far from a saved place when one is named.
const searchRange = 16
const placeRange = 8
// Remembered chests this far away are still worth walking to for a "take".
const rememberedRange = 64
// Automatic drop-off: only to a base this close, and not again for a while if it didn't work.
const dropOffRange = 96
const dropOffRetryMs = 2 * 60_000
// Leave this many slots free when taking things out to sort, for what turns up.
const spareSlots = 2

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pretty = (name) => name.replaceAll('_', ' ')

const toolSuffixes = /_(pickaxe|axe|shovel|hoe|sword|helmet|chestplate|leggings|boots)$/
const keptNames = new Set(['bow', 'crossbow', 'arrow', 'spectral_arrow', 'tipped_arrow', 'shield', 'shears', 'fishing_rod',
  'flint_and_steel', 'torch'])

/** True for what "put everything away" leaves on the bot: tools, weapons, armor, torches, food. */
export function keeps(name, isFood = () => false) {
  return toolSuffixes.test(name) || keptNames.has(name) || isFood(name)
}

/** "iron" matches iron_ingot and raw_iron, "oak log" oak_log, "planks" any planks. Like the backend. */
export function itemMatches(name, wanted) {
  wanted = wanted.toLowerCase().trim().replaceAll(' ', '_').replace(/^minecraft:/, '')
  return name === wanted || name.split('_').includes(wanted) || name.startsWith(`${wanted}_`) || name.endsWith(`_${wanted}`)
}

const clockwise = { north: 'east', east: 'south', south: 'west', west: 'north' }
const step = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }

/** The other half of a double chest ({ facing, type } are its block properties), or null. */
export function chestPartner(pos, { facing, type } = {}) {
  if (type !== 'left' && type !== 'right') return null
  // As in Minecraft: a left half's partner is clockwise of where it faces, a right half's anticlockwise.
  const side = type === 'left' ? clockwise[facing] : Object.keys(clockwise).find((k) => clockwise[k] === facing)
  const [dx, dz] = step[side]
  return pos.offset(dx, 0, dz)
}

/**
 * Where each item should live when sorting: the chest that already holds the most of it.
 * `chests` is [{ key, items: { name: count } }]; returns { name: key }.
 */
export function sortPlan(chests) {
  const plan = {}
  const most = {}
  for (const chest of chests) {
    for (const [name, count] of Object.entries(chest.items)) {
      if (count > (most[name] ?? 0)) { most[name] = count; plan[name] = chest.key }
    }
  }
  return plan
}

const chestKey = (pos, dimension) => `${dimension}:${pos.x},${pos.y},${pos.z}`

// What the bot remembers about chests: key -> { x, y, z, dimension, items }. Loaded from the backend
// on join and kept across reconnects.
const memory = new Map()

export function setChestMemory(chests) {
  memory.clear()
  for (const c of chests ?? []) memory.set(chestKey(c, c.dimension), c)
}

export function installStorage(bot, { say, log, survival, resume, reportChest, forgetChest }) {
  const containerIds = containers.map((n) => bot.registry.blocksByName[n]?.id).filter((id) => id != null)
  const isFood = (name) => Boolean(bot.registry.foodsByName?.[name])
  const me = () => bot.entity.position
  const dimension = () => bot.game.dimension

  async function waitForReflexes(task) {
    while (!task.cancelled && survival.busy()) await sleep(500)
  }

  // Walk somewhere, waiting out reflexes that interrupt and trying again (up to three times).
  async function walk(task, goal, isThere, ms = 60_000) {
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

  // Forget remembered chests near `center` that are gone: the block is loaded and isn't a chest.
  function forgetGone(center, range) {
    for (const [key, c] of memory) {
      const pos = new Vec3(c.x, c.y, c.z)
      if (c.dimension !== dimension() || pos.distanceTo(center) > range) continue
      const block = bot.blockAt(pos)
      if (!block || containers.includes(block.name)) continue
      memory.delete(key)
      forgetChest(c)
      log('INFO', `forgot the chest at ${pos}: it's gone`)
    }
  }

  // Chests and barrels within `range` of `center`, one entry per double chest, nearest to the bot first.
  function containersNear(center, range) {
    forgetGone(center, range)
    const seen = new Set()
    const found = []
    for (const pos of bot.findBlocks({ matching: containerIds, maxDistance: range, count: 64, point: center })) {
      if (seen.has(pos.toString())) continue
      const block = bot.blockAt(pos)
      const partner = block.name.endsWith('chest') ? chestPartner(pos, block.getProperties()) : null
      if (partner) seen.add(partner.toString())
      found.push(block)
    }
    return found.sort((a, b) => a.position.distanceTo(me()) - b.position.distanceTo(me()))
  }

  // Remember what's in an open chest, here and in the backend.
  function record(block, window) {
    const items = {}
    for (const i of window.containerItems()) items[i.name] = (items[i.name] ?? 0) + i.count
    const { x, y, z } = block.position
    const chest = { x, y, z, dimension: dimension(), items }
    memory.set(chestKey(block.position, chest.dimension), chest)
    reportChest(chest)
    return items
  }

  // Walk to a chest and open it. The caller closes it.
  async function open(task, block) {
    const pos = block.position
    await walk(task, () => new goals.GoalNear(pos.x, pos.y, pos.z, 2), () => me().distanceTo(pos.offset(0.5, 0.5, 0.5)) <= 3.5)
    const current = bot.blockAt(pos)
    if (!containers.includes(current?.name)) {
      forgetGone(pos, 1)
      throw new Error('the chest is gone')
    }
    return bot.openContainer(current)
  }

  const where = (block) => `(${block.position.x}, ${block.position.y}, ${block.position.z})`
  const tally = (counts) => Object.entries(counts).map(([name, n]) => `${n} ${pretty(name)}`).join(', ')
  const centerOf = ({ x, y, z }) => (x == null ? me().floored() : new Vec3(x, y, z))

  // --- Storing ------------------------------------------------------------
  // Put `which` items (a filter) into the chests, up to `limit` in total, and with `amounts` ({ name:
  // count }) no more than that of each. Returns { stored, full, chests }.
  async function putAway(task, chests, which, limit = Infinity, amounts = null) {
    const stored = {}
    let left = limit
    const allowed = (name) => (amounts ? (amounts[name] ?? 0) - (stored[name] ?? 0) : Infinity)
    const used = []
    for (const block of chests) {
      const stacks = bot.inventory.items().filter((i) => which(i.name) && allowed(i.name) > 0)
      if (stacks.length === 0 || left <= 0 || task.cancelled) break
      await waitForReflexes(task)
      let window
      try {
        window = await open(task, block)
      } catch (err) {
        if (task.cancelled) break
        log('WARN', `couldn't open the chest at ${block.position}: ${err.message}`)
        continue
      }
      try {
        for (const stack of stacks) {
          if (left <= 0) break
          const n = Math.min(stack.count, left, allowed(stack.name))
          if (n <= 0) continue
          try {
            await window.deposit(stack.type, null, n)
          } catch {
            break // this chest is full
          }
          stored[stack.name] = (stored[stack.name] ?? 0) + n
          left -= n
        }
        record(block, window)
        used.push(block)
      } finally {
        window.close()
      }
    }
    const full = bot.inventory.items().some((i) => which(i.name) && allowed(i.name) > 0) && left > 0
    return { stored, full, chests: used }
  }

  function chestsFor({ x, y, z, label }) {
    const near = x != null
    const chests = containersNear(centerOf({ x, y, z }), near ? placeRange : searchRange)
    const place = label ? ` near ${label}` : near ? ` near (${x}, ${y}, ${z})` : ''
    return { chests, place }
  }

  // The base: chests within placeRange of a saved place in this dimension, nearest place first.
  function baseChests() {
    const spots = protectedPlaces().filter((s) => s.dimension === dimension())
      .map((s) => new Vec3(s.x, s.y, s.z))
      .filter((p) => p.distanceTo(me()) <= dropOffRange)
      .sort((a, b) => a.distanceTo(me()) - b.distanceTo(me()))
    for (const spot of spots) {
      const loaded = containersNear(spot, placeRange)
      if (loaded.length) return loaded
      // Too far to see: go by memory, and look properly on arrival.
      const remembered = [...memory.values()].filter((c) => c.dimension === dimension() && spot.distanceTo(new Vec3(c.x, c.y, c.z)) <= placeRange)
      if (remembered.length) return remembered.map((c) => ({ position: new Vec3(c.x, c.y, c.z), name: 'chest' }))
    }
    return []
  }

  function store({ item, count, x, y, z, label }) {
    const everything = !item || ['everything', 'all', 'it all', 'stuff', 'all of it'].includes(item.toLowerCase().trim())
    const which = everything ? (name) => !keeps(name, isFood) : (name) => itemMatches(name, item)
    startTask(`putting away ${everything ? 'everything' : pretty(item)}`, async (task) => {
      if (!bot.inventory.items().some((i) => which(i.name))) {
        say(everything ? 'I have nothing to put away.' : `I don't have any ${pretty(item)}.`)
        return
      }
      const { chests, place } = chestsFor({ x, y, z, label })
      if (chests.length === 0) {
        say(`There's no chest${place || ` within ${searchRange} blocks`}.`)
        return
      }
      const { stored, full, chests: used } = await putAway(task, chests, which, count ?? Infinity)
      if (task.cancelled) return
      if (Object.keys(stored).length === 0) say(`I couldn't put anything away: the chests${place} are full.`)
      else say(`Put away ${tally(stored)}${used.length === 1 ? ` in the chest at ${where(used[0])}` : ''}.${full ? ' The chests are full, so I kept the rest.' : ''}`)
    }, { log, onCancel: () => bot.pathfinder.setGoal(null), onEnd: resume })
  }

  // --- Taking -------------------------------------------------------------
  function take({ item, count, x, y, z, label }) {
    startTask(`getting ${pretty(item)} from the chests`, async (task) => {
      if (bot.inventory.emptySlotCount() === 0) {
        say("My inventory is full, so I can't take anything out.")
        return
      }
      const center = centerOf({ x, y, z })
      const range = x != null ? placeRange : searchRange
      // Chests remembered to have it first (nearest first), then any others nearby to look in.
      const remembered = [...memory.values()]
        .filter((c) => c.dimension === dimension() && Object.keys(c.items).some((n) => itemMatches(n, item)))
        .map((c) => new Vec3(c.x, c.y, c.z))
        .filter((p) => p.distanceTo(x != null ? center : me()) <= (x != null ? placeRange : rememberedRange))
        .sort((a, b) => a.distanceTo(me()) - b.distanceTo(me()))
      const others = containersNear(center, range).map((b) => b.position).filter((p) => !remembered.some((r) => r.equals(p)))
      const got = {}
      let left = count ?? Infinity
      let opened = 0
      for (const pos of [...remembered, ...others]) {
        if (left <= 0 || task.cancelled || bot.inventory.emptySlotCount() === 0) break
        await waitForReflexes(task)
        let window
        try {
          window = await open(task, { position: pos })
        } catch (err) {
          if (task.cancelled) break
          log('WARN', `couldn't open the chest at ${pos}: ${err.message}`)
          continue
        }
        opened++
        try {
          for (const stack of window.containerItems().filter((i) => itemMatches(i.name, item))) {
            if (left <= 0) break
            const n = Math.min(stack.count, left)
            try {
              await window.withdraw(stack.type, null, n)
            } catch {
              break // inventory full
            }
            got[stack.name] = (got[stack.name] ?? 0) + n
            left -= n
          }
          record(bot.blockAt(pos), window)
        } finally {
          window.close()
        }
      }
      if (task.cancelled) return
      if (Object.keys(got).length) say(`Got ${tally(got)}${count && left > 0 ? `; that's all there was` : ''}.`)
      else if (opened === 0) say(`There's no chest${label ? ` near ${label}` : ' nearby'} to look in.`)
      else say(`There's no ${pretty(item)} in the ${opened === 1 ? 'chest' : `${opened} chests`} I looked in.`)
    }, { log, onCancel: () => bot.pathfinder.setGoal(null), onEnd: resume })
  }

  // --- Looking and sorting ------------------------------------------------
  // Open each chest and remember what's inside. Returns [{ block, key, items }].
  async function lookInto(task, chests) {
    const looked = []
    for (const block of chests) {
      if (task.cancelled) break
      await waitForReflexes(task)
      let window
      try {
        window = await open(task, block)
      } catch (err) {
        if (task.cancelled) break
        log('WARN', `couldn't open the chest at ${block.position}: ${err.message}`)
        continue
      }
      try {
        looked.push({ block, key: chestKey(block.position, dimension()), items: record(block, window) })
      } finally {
        window.close()
      }
    }
    return looked
  }

  function inspect({ x, y, z, label }) {
    startTask('looking in the chests', async (task) => {
      const { chests, place } = chestsFor({ x, y, z, label })
      if (chests.length === 0) {
        say(`There's no chest${place || ` within ${searchRange} blocks`}.`)
        return
      }
      const looked = await lookInto(task, chests)
      if (task.cancelled) return
      const totals = {}
      for (const { items } of looked) for (const [name, n] of Object.entries(items)) totals[name] = (totals[name] ?? 0) + n
      const top = Object.entries(totals).sort((a, b) => b[1] - a[1])
      const list = top.slice(0, 8).map(([name, n]) => `${n} ${pretty(name)}`).join(', ')
      const more = top.length > 8 ? ` and ${top.length - 8} other kinds` : ''
      say(top.length ? `Looked in ${looked.length} chests: ${list}${more}.` : `Looked in ${looked.length} chests: they're empty.`)
    }, { log, onCancel: () => bot.pathfinder.setGoal(null), onEnd: resume })
  }

  function sort({ x, y, z, label }) {
    startTask('sorting the chests', async (task) => {
      const { chests, place } = chestsFor({ x, y, z, label })
      if (chests.length < 2) {
        say(chests.length ? 'There\'s only one chest here, nothing to sort.' : `There's no chest${place || ' nearby'}.`)
        return
      }
      let looked = await lookInto(task, chests)
      const plan = sortPlan(looked)
      const byKey = new Map(looked.map((l) => [l.key, l.block]))
      let moved = 0
      // Carry misplaced items over in loads that fit in the inventory, a few rounds at most.
      for (let round = 0; round < 6 && !task.cancelled; round++) {
        const carrying = {}
        for (const { block, key, items } of looked) {
          const misplaced = Object.keys(items).filter((name) => plan[name] !== key)
          if (misplaced.length === 0 || bot.inventory.emptySlotCount() <= spareSlots) continue
          let window
          try {
            window = await open(task, block)
          } catch (err) {
            if (task.cancelled) return
            log('WARN', `couldn't open the chest at ${block.position}: ${err.message}`)
            continue
          }
          try {
            for (const stack of window.containerItems().filter((i) => misplaced.includes(i.name))) {
              if (bot.inventory.emptySlotCount() <= spareSlots) break
              await window.withdraw(stack.type, null, stack.count).catch(() => {})
              carrying[stack.name] = (carrying[stack.name] ?? 0) + stack.count
            }
            record(block, window)
          } finally {
            window.close()
          }
        }
        if (Object.keys(carrying).length === 0) break
        // Take each load to where it belongs; anything that doesn't fit goes back to any chest with room.
        for (const [key, block] of byKey) {
          const names = Object.keys(carrying).filter((n) => plan[n] === key)
          if (names.length === 0) continue
          // Only what it took out: the bot may carry some of the same items of its own.
          const { stored } = await putAway(task, [block], (n) => names.includes(n), Infinity, carrying)
          for (const [name, n] of Object.entries(stored)) { carrying[name] -= n; moved += n }
        }
        const leftover = Object.keys(carrying).filter((n) => carrying[n] > 0)
        if (leftover.length) await putAway(task, [...byKey.values()], (n) => leftover.includes(n), Infinity, carrying)
        looked = await lookInto(task, [...byKey.values()])
      }
      if (task.cancelled) return
      say(moved ? `Sorted ${byKey.size} chests: moved ${moved} items so each kind is together.` : 'The chests were already sorted.')
    }, { log, onCancel: () => bot.pathfinder.setGoal(null), onEnd: resume })
  }

  // --- Dropping off at the base -------------------------------------------
  /**
   * Take everything but tools, armor and food to a chest at the base, inside the current job (a
   * gathering job whose inventory filled up). Returns true if it freed some space.
   */
  async function dropOff(task) {
    const chests = baseChests()
    if (chests.length === 0) return false
    say('My inventory is full, taking things to the base.')
    const before = bot.inventory.emptySlotCount()
    const back = me().floored()
    await putAway(task, chests, (name) => !keeps(name, isFood))
    if (task.cancelled) return false
    const freed = bot.inventory.emptySlotCount() > before
    if (freed) {
      // Back to where it was working.
      await walk(task, () => new goals.GoalNear(back.x, back.y, back.z, 2), () => me().distanceTo(back) <= 3).catch(() => {})
    }
    return freed
  }

  // When idle with a full inventory, take things to the base by itself.
  let lastDropOff = 0
  const dropOffTimer = setInterval(() => {
    if (!bot.entity || currentTask() || survival.busy() || bot.inventory.emptySlotCount() > 0) return
    if (Date.now() - lastDropOff < dropOffRetryMs) return
    lastDropOff = Date.now()
    if (baseChests().length === 0) return
    startTask('dropping things off at the base', async (task) => {
      const freed = await dropOff(task)
      if (!task.cancelled && !freed) say("I couldn't drop anything off: the chests at the base are full.")
    }, { log, onCancel: () => bot.pathfinder.setGoal(null), onEnd: resume })
  }, 5000)
  bot.once('end', () => clearInterval(dropOffTimer))

  return { store, take, inspect, sort, dropOff }
}
