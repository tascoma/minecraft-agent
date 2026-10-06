// Gathering jobs: collect a number of an item by breaking the blocks that drop it, and hand
// items to the player. Both run as tasks (see tasks.js) and report back in chat themselves.
import pathfinderPkg from 'mineflayer-pathfinder'
import { plugin as toolPlugin } from 'mineflayer-tool'
import { CompanionMovements, isManMade, isProtected } from './movements.js'
import { startTask } from './tasks.js'
import { goWithin } from './walk.js'

const { goals } = pathfinderPkg

// How far to look for blocks to break, in blocks.
const searchRadius = 48
// Give up on a job after this many blocks in a row couldn't be reached or broken. Near a saved
// place many are out of reach (no digging or building there), and each failure takes under a second.
const maxFailures = 10
// With digging allowed every block is a possible route, so an unbounded path search can use
// gigabytes. During jobs, only search this far from the bot (targets are within searchRadius).
const pathSearchRadius = searchRadius + 32
// Give up on one block after this long (the pathfinder can keep re-planning forever).
const blockTimeoutMs = 45_000
const maxCount = 64
// Mining trips: how long the walk down may take, and how far and how many times to tunnel out.
const descendMs = 5 * 60_000
const legLength = 24
const legMs = 3 * 60_000
const maxLegs = 6

// Items minecraft-data doesn't list as drops because they only drop sometimes: item -> the blocks
// that drop it (gravel drops flint one time in ten, grass drops wheat seeds one time in eight).
const chanceDrops = {
  flint: ['gravel'],
  wheat_seeds: ['short_grass', 'tall_grass'],
}

// The height each ore is most common at, for mining trips (by the item it drops).
export const oreLevels = {
  diamond: -58, redstone: -58, lapis_lazuli: 0, raw_gold: -16, raw_iron: 16, raw_copper: 48, coal: 96, emerald: 100,
}

// Words players use for "any kind of X".
const aliases = {
  log: (name) => name.endsWith('_log'),
  logs: (name) => name.endsWith('_log'),
  wood: (name) => name.endsWith('_log'),
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Blocks the bot couldn't reach, remembered across jobs for a while so it doesn't keep climbing the
// same half-chopped tree. Position string → time it was given up on.
const unreachable = new Map()
const unreachableMs = 5 * 60_000
const isUnreachable = (pos) => Date.now() - (unreachable.get(pos.toString()) ?? 0) < unreachableMs
const pretty = (name) => name.replaceAll('_', ' ')

/**
 * Works out what to break for a request like "cobblestone", "oak_log", "log", "coal" or "iron_ore".
 * Returns the block ids to break and the item names that count towards the total, or null.
 */
export function resolveTarget(registry, name) {
  name = name.toLowerCase().trim().replaceAll(' ', '_').replace(/^minecraft:/, '')
  const natural = (block) => block.diggable && !isManMade(block.name)
  let blocks
  if (aliases[name]) {
    blocks = registry.blocksArray.filter((b) => aliases[name](b.name) && natural(b))
  } else {
    // An item: break whatever natural blocks drop it (cobblestone comes from stone, dirt from grass too).
    const id = registry.itemsByName[name]?.id
    blocks = id == null ? [] : registry.blocksArray.filter((b) => natural(b) && b.drops?.includes(id))
    // A block that drops something else, like iron_ore (raw iron) or stone (cobblestone): break it
    // and its deepslate variant.
    if (!blocks.length && registry.blocksByName[name] && natural(registry.blocksByName[name])) {
      blocks = [registry.blocksByName[name], registry.blocksByName[`deepslate_${name}`]].filter(Boolean)
    }
  }
  if (!blocks?.length && chanceDrops[name]) {
    blocks = chanceDrops[name].map((n) => registry.blocksByName[n]).filter(Boolean)
    if (blocks.length) return { blockIds: blocks.map((b) => b.id), items: new Set([name]), label: pretty(name) }
  }
  if (!blocks?.length) return null
  const items = new Set(blocks.flatMap((b) => (b.drops ?? []).map((id) => registry.items[id]?.name)).filter(Boolean))
  // Name what the player ends up with: "stone" gives cobblestone, "iron ore" gives raw iron.
  const label = aliases[name] ? 'logs' : items.size === 1 ? pretty([...items][0]) : pretty(name)
  return { blockIds: blocks.map((b) => b.id), items, label }
}

/** True for a tool with only a few uses left (5% of its durability, or 3 uses, whichever is more). */
export function nearlyBroken(item) {
  if (!item?.maxDurability) return false
  const left = item.maxDurability - (item.durabilityUsed ?? 0)
  return left <= Math.max(3, Math.ceil(item.maxDurability * 0.05))
}

export function installGathering(bot, { say, log, survival, resume }) {
  bot.loadPlugin(toolPlugin) // picks the right tool for each block

  const countItems = (names) => bot.inventory.items().filter((i) => names.has(i.name)).reduce((n, i) => n + i.count, 0)

  // The tool the bot would use on `block`, if it's nearly broken and there's no spare: its name.
  function wornTool(block) {
    const tool = bot.pathfinder.bestHarvestTool(block)
    if (!tool || !nearlyBroken(tool)) return null
    const spares = bot.inventory.items().filter((i) => i.name === tool.name && !nearlyBroken(i))
    return spares.length ? null : tool.name
  }

  // Stone and ores drop nothing without the right tool. Returns the cheapest tool that would do
  // (e.g. "wooden_pickaxe"), or null if the bot already has one.
  function missingTool(block) {
    if (!block.harvestTools) return null
    const have = new Set(bot.inventory.items().map((i) => i.type))
    if (Object.keys(block.harvestTools).some((id) => have.has(Number(id)))) return null
    return bot.registry.items[Object.keys(block.harvestTools)[0]].name
  }

  function findBlock(target, skipped) {
    // Filter inside the search, not after: near home the nearest few hundred stone blocks can all be
    // in the protected zone, and filtering a capped result afterwards would leave nothing.
    const allowed = (block) => !skipped.has(block.position.toString()) && !isUnreachable(block.position) &&
      !isProtected(block.position, bot.game.dimension)
    const found = bot.findBlocks({ matching: target.blockIds, maxDistance: searchRadius, count: 20, useExtraInfo: allowed })
    // Prefer blocks near the bot's own height: a log 10 blocks up means climbing into the canopy,
    // where the bot can get stuck. Each block of height difference counts like 3 blocks of distance.
    const me = bot.entity.position
    const cost = (pos) => pos.distanceTo(me) + 2 * Math.abs(pos.y - me.y)
    const [best] = found.sort((a, b) => cost(a) - cost(b))
    return best ? bot.blockAt(best) : null
  }

  // Stop walking and digging, e.g. when a job is cancelled or a block takes too long.
  function halt() {
    bot.pathfinder.setGoal(null)
    bot.stopDigging()
  }

  // Break one block and pick up what it drops, giving up after blockTimeoutMs. (Done here rather than
  // with mineflayer-collectblock, which waits forever for a drop it can't reach.)
  async function collectOne(block) {
    const work = (async () => {
      await bot.pathfinder.goto(new goals.GoalLookAtBlock(block.position, bot.world))
      const current = bot.blockAt(block.position)
      if (current?.type !== block.type) return // someone else broke it meanwhile
      await bot.tool.equipForBlock(current, { requireHarvest: true })
      await bot.dig(current)
      await pickUpDrops(block.position)
    })()
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        halt()
        reject(Object.assign(new Error(`gave up after ${blockTimeoutMs / 1000}s`), { name: 'BlockTimeout' }))
      }, blockTimeoutMs)
    })
    work.catch(() => {}) // if the timeout wins, the abandoned attempt's error doesn't matter
    try {
      await Promise.race([work, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  // Walk over the items a broken block dropped, for up to 5 seconds. A drop that rolled out of
  // reach is left behind rather than holding up the job.
  async function pickUpDrops(pos) {
    const deadline = Date.now() + 5000
    await sleep(250) // drops appear a moment after the block breaks
    while (Date.now() < deadline) {
      const drop = bot.nearestEntity((e) => e.name === 'item' && e.position.distanceTo(pos) < 4)
      if (!drop) return
      const { x, y, z } = drop.position
      const reached = bot.pathfinder.goto(new goals.GoalNear(x, y, z, 0)).then(() => true, () => false)
      const outOfTime = sleep(Math.max(0, deadline - Date.now())).then(() => false)
      if (!(await Promise.race([reached, outOfTime]))) { bot.pathfinder.setGoal(null); return }
      await sleep(200)
    }
  }

  // Gathering can nest (making a pickaxe mid-gather may gather logs), so only switch back to the
  // walking rules when the outermost gather ends.
  let gathering = 0
  function enterGathering() {
    if (gathering++ === 0) setMovements(new CompanionMovements(bot, { gather: true }), true)
  }
  function leaveGathering() {
    if (--gathering === 0) setMovements(new CompanionMovements(bot), false)
  }
  function setMovements(movements, gather) {
    bot.pathfinder.setMovements(movements)
    bot.pathfinder.searchRadius = gather ? pathSearchRadius : -1
  }

  // A cancelled job: stop moving and digging, and go back to the walking rules however deeply
  // gathering was nested.
  function stop() {
    halt()
    if (gathering === 0) return
    gathering = 1
    leaveGathering()
  }

  // Set by crafting.js: makes a tool the bot needs for gathering, e.g. a wooden pickaxe for stone.
  let makeTool = null
  // Set by storage.js: empties the inventory into a chest at the base, true if that freed space.
  let dropOff = null

  /**
   * Break blocks until the bot has `count` more of `target`'s items. Used by the collect job and by
   * crafting. Returns how many it got and, if short, why. `onProgress(got)` runs after each block.
   */
  async function gather(task, target, count, { onProgress } = {}) {
    const start = countItems(target.items)
    const got = () => countItems(target.items) - start
    const skipped = new Set()
    let failures = 0
    let reason = null
    // True when it stopped because there's nothing left in range (rather than getting stuck).
    let exhausted = false
    enterGathering()
    try {
      while (!task.cancelled && got() < count) {
        // Let a survival reflex (backing off, eating, sleeping) finish before carrying on.
        if (survival.busy()) { await sleep(500); continue }
        // A full inventory can't take any more: empty it at the base if there is one.
        if (bot.inventory.emptySlotCount() === 0) {
          if (!dropOff || !(await dropOff(task))) { reason = 'my inventory is full'; break }
          continue
        }
        const block = findBlock(target, skipped)
        if (!block) {
          reason = `there's no more ${target.label} within ${searchRadius} blocks I'm allowed to dig`
          exhausted = true
          break
        }
        const tool = missingTool(block)
        if (tool) {
          const kind = pretty(tool.replace(/^(wooden|stone|golden|iron|diamond|netherite)_/, ''))
          if (!makeTool) { reason = `I need a ${kind} to mine ${pretty(block.name)}`; break }
          try {
            await makeTool(task, tool)
            continue
          } catch (err) {
            reason = `I need a ${kind} to mine ${pretty(block.name)} and couldn't make one: ${err.message}`
            break
          }
        }
        // Replace a tool before it breaks halfway through, rather than after (a job that loses its
        // pickaxe mid-way then digs stone by hand, or stops).
        const worn = makeTool && wornTool(block)
        if (worn) {
          try {
            await makeTool(task, worn, countItems(new Set([worn])) + 1)
          } catch (err) {
            log('WARN', `couldn't replace the worn ${worn}: ${err.message}`)
          }
          if (task.cancelled) break
        }
        try {
          await collectOne(block)
          log('INFO', `collected ${block.name} at ${block.position}`)
          failures = 0
        } catch (err) {
          if (task.cancelled) break
          // A reflex took over mid-dig: not this block's fault, so try it again.
          if (survival.busy()) continue
          log('WARN', `couldn't collect ${block.name} at ${block.position} (bot at ${bot.entity.position.floored()}): ${err.message}`)
          skipped.add(block.position.toString())
          unreachable.set(block.position.toString(), Date.now())
          if (++failures >= maxFailures) { reason = `I keep getting stuck reaching the ${target.label}`; break }
        }
        onProgress?.(got())
      }
    } finally {
      leaveGathering()
    }
    return { got: got(), reason, exhausted }
  }

  function collect({ item, count }) {
    const target = resolveTarget(bot.registry, item)
    if (!target) {
      say(`I don't know how to get "${item}".`)
      return
    }
    count = Math.max(1, Math.min(count ?? 1, maxCount))

    startTask(`getting ${count} ${target.label}`, async (task) => {
      let halfwayReported = false
      const { got, reason } = await gather(task, target, count, {
        onProgress: (n) => {
          task.progress = `${Math.min(n, count)}/${count}`
          if (!halfwayReported && count >= 8 && n >= count / 2 && n < count) {
            halfwayReported = true
            say(`${n}/${count} ${target.label} so far.`)
          }
        },
      })
      if (task.cancelled) return
      if (got >= count) say(`Got ${count} ${target.label}.`)
      else if (got > 0) say(`I only got ${got} ${target.label}: ${reason}.`)
      else say(`I couldn't get any ${target.label}: ${reason}.`)
    }, {
      log,
      onCancel: stop,
      onEnd: resume,
    })
  }

  // A long walk inside a job. A reflex that interrupts it (a fight, eating) isn't a failure: wait for
  // it to finish and let the caller carry on from wherever the bot is.
  async function travel(task, goal, ms) {
    try {
      await goWithin(bot, goal, ms)
    } catch (err) {
      if (task.cancelled || !survival.busy()) throw err
      while (!task.cancelled && survival.busy()) await sleep(500)
    }
  }

  // A mining trip for an ore: look nearby first, then go down to the height it's most common at,
  // then tunnel outwards in legs, looking again after each, until it has enough or gives up.
  function mineFor({ item, count }) {
    const target = resolveTarget(bot.registry, item)
    const level = target && [...target.items].map((i) => oreLevels[i]).find((y) => y != null)
    if (!target || level == null) {
      say(`I don't know where to dig for "${item}". I can go mining for diamonds, iron, gold, copper, coal, redstone, lapis and emeralds.`)
      return
    }
    count = Math.max(1, Math.min(count ?? 1, maxCount))
    startTask(`mining for ${count} ${target.label}`, async (task) => {
      let got = 0
      let reason = null
      let legs = 0
      let descents = 0
      enterGathering()
      try {
        // The pickaxe that ore needs, before the long trip down (diamonds need iron or better).
        const ore = bot.registry.blocks[target.blockIds[0]]
        const tool = missingTool(ore)
        if (tool) {
          if (!makeTool) throw new Error(`I need a ${pretty(tool)}`)
          await makeTool(task, tool)
        }
        while (!task.cancelled && got < count) {
          const result = await gather(task, target, count - got, {
            onProgress: (n) => { task.progress = `${got + n}/${count}` },
          })
          got += result.got
          if (got >= count || task.cancelled) break
          if (!result.exhausted) { reason = result.reason; break }
          const here = bot.entity.position.floored()
          if (Math.abs(here.y - level) > 4) {
            if (++descents > 3) { reason = `I can't get down to y ${level} from here`; break }
            if (descents === 1) say(`Heading ${here.y > level ? 'down' : 'up'} to y ${level}, where ${target.label} is most common.`)
            await travel(task, new goals.GoalY(level), descendMs)
          } else if (legs < maxLegs) {
            // A new direction each leg: east, south, west, north.
            const [dx, dz] = [[1, 0], [0, 1], [-1, 0], [0, -1]][legs % 4]
            legs++
            task.progress = `${got}/${count}, tunnel ${legs}/${maxLegs}`
            await travel(task, new goals.GoalXZ(here.x + dx * legLength, here.z + dz * legLength), legMs)
          } else {
            reason = `I tunnelled ${maxLegs} times and found no more`
            break
          }
        }
      } catch (err) {
        if (!task.cancelled) reason = err.message
      } finally {
        leaveGathering()
      }
      if (task.cancelled) return
      const y = Math.floor(bot.entity.position.y)
      const back = y < 50 ? ` I'm down at y ${y}; say "tp to me" or "follow me" to bring me back.` : ''
      if (got >= count) say(`Found ${got} ${target.label}.${back}`)
      else if (got > 0) say(`I only found ${got} ${target.label}: ${reason}.${back}`)
      else say(`I couldn't find any ${target.label}: ${reason}.${back}`)
    }, { log, onCancel: stop, onEnd: resume })
  }

  // Pick up every dropped item within `radius` blocks (only when asked: it would also take things the
  // player meant to leave). Nearest first; one that can't be reached in 10 seconds is skipped.
  function pickUpAround({ count: radius }) {
    radius = Math.max(2, Math.min(radius ?? 8, 16))
    startTask('picking up items', async (task) => {
      const start = bot.inventory.items().reduce((n, i) => n + i.count, 0)
      const skipped = new Set()
      for (let i = 0; i < 40 && !task.cancelled; i++) {
        if (survival.busy()) { await sleep(500); continue }
        if (bot.inventory.emptySlotCount() === 0) break
        const drop = bot.nearestEntity((e) => e.name === 'item' && !skipped.has(e.id) && e.position.distanceTo(bot.entity.position) <= radius)
        if (!drop) break
        const p = drop.position
        try {
          await goWithin(bot, new goals.GoalNear(p.x, p.y, p.z, 0), 10_000)
          await sleep(250)
        } catch {
          if (task.cancelled) return
          skipped.add(drop.id)
        }
      }
      if (task.cancelled) return
      const got = bot.inventory.items().reduce((n, i) => n + i.count, 0) - start
      if (bot.inventory.emptySlotCount() === 0) say(`Picked up ${got} items, and now my inventory is full.`)
      else say(got > 0 ? `Picked up ${got} items.` : `There's nothing lying around within ${radius} blocks.`)
    }, { log, onCancel: () => bot.pathfinder.setGoal(null), onEnd: resume })
  }

  // Walk to the player and toss them `count` of an item (all of it if count is missing).
  function give({ username, item, count }) {
    const name = item.toLowerCase().trim().replaceAll(' ', '_').replace(/^minecraft:/, '')
    const matches = (i) => (aliases[name] ? aliases[name](i.name) : i.name === name)
    const have = bot.inventory.items().filter(matches).reduce((n, i) => n + i.count, 0)
    if (have === 0) {
      say(`I don't have any ${pretty(name)}.`)
      return
    }
    const amount = Math.min(count ?? have, have)

    startTask(`giving ${amount} ${pretty(name)} to ${username}`, async (task) => {
      const player = bot.players[username]?.entity
      if (!player) {
        say(`I can't see you, ${username}. Come closer and ask again.`)
        return
      }
      try {
        await goWithin(bot, new goals.GoalFollow(player, 2), 60_000)
      } catch (err) {
        if (!task.cancelled) say(`I can't reach you to hand them over.`)
        return
      }
      if (task.cancelled) return
      await bot.lookAt(player.position.offset(0, 1.6, 0))
      // bot.toss takes items of one type from all stacks, so toss per item type, not per stack.
      const types = [...new Set(bot.inventory.items().filter(matches).map((i) => i.type))]
      let left = amount
      for (const type of types) {
        if (left <= 0 || task.cancelled) break
        const n = Math.min(left, bot.inventory.count(type, null))
        await bot.toss(type, null, n)
        left -= n
      }
      const given = amount - left
      say(given < (count ?? 0) ? `Here's all I had: ${given} ${pretty(name)}.` : `Here's ${given} ${pretty(name)}.`)
    }, {
      log,
      onCancel: () => bot.pathfinder.setGoal(null),
      onEnd: resume,
    })
  }

  return {
    collect,
    give,
    gather,
    mineFor,
    pickUpAround,
    pickUpDrops,
    stop,
    setToolMaker: (fn) => { makeTool = fn },
    setDropOff: (fn) => { dropOff = fn },
  }
}
