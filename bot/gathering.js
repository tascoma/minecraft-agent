// Gathering jobs: collect a number of an item by breaking the blocks that drop it, and hand
// items to the player. Both run as tasks (see tasks.js) and report back in chat themselves.
import pathfinderPkg from 'mineflayer-pathfinder'
import { plugin as collectBlock } from 'mineflayer-collectblock'
import { CompanionMovements, isManMade, isProtected } from './movements.js'
import { startTask } from './tasks.js'

const { goals } = pathfinderPkg

// How far to look for blocks to break, in blocks.
const searchRadius = 48
// Give up on a job after this many blocks in a row couldn't be reached or broken.
const maxFailures = 5
// With digging allowed every block is a possible route, so an unbounded path search can use
// gigabytes. During jobs, only search this far from the bot (targets are within searchRadius).
const pathSearchRadius = searchRadius + 32
// Give up on one block after this long (the pathfinder can keep re-planning forever).
const blockTimeoutMs = 45_000
const maxCount = 64

// Words players use for "any kind of X".
const aliases = {
  log: (name) => name.endsWith('_log'),
  logs: (name) => name.endsWith('_log'),
  wood: (name) => name.endsWith('_log'),
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
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
  if (!blocks?.length) return null
  const items = new Set(blocks.flatMap((b) => (b.drops ?? []).map((id) => registry.items[id]?.name)).filter(Boolean))
  // Name what the player ends up with: "stone" gives cobblestone, "iron ore" gives raw iron.
  const label = aliases[name] ? 'logs' : items.size === 1 ? pretty([...items][0]) : pretty(name)
  return { blockIds: blocks.map((b) => b.id), items, label }
}

export function installGathering(bot, { say, log, survival, resume }) {
  bot.loadPlugin(collectBlock)

  const countItems = (names) => bot.inventory.items().filter((i) => names.has(i.name)).reduce((n, i) => n + i.count, 0)

  // Stone and ores drop nothing without the right tool. Returns the tool it lacks, or null.
  function missingTool(block) {
    if (!block.harvestTools) return null
    const have = new Set(bot.inventory.items().map((i) => i.type))
    if (Object.keys(block.harvestTools).some((id) => have.has(Number(id)))) return null
    const cheapest = bot.registry.items[Object.keys(block.harvestTools)[0]].name
    return cheapest.replace(/^(wooden|stone|golden|iron|diamond|netherite)_/, '')
  }

  function findBlock(target, skipped) {
    // Filter inside the search, not after: near home the nearest few hundred stone blocks can all be
    // in the protected zone, and filtering a capped result afterwards would leave nothing.
    const allowed = (block) => !skipped.has(block.position.toString()) && !isProtected(block.position, bot.game.dimension)
    const [pos] = bot.findBlocks({ matching: target.blockIds, maxDistance: searchRadius, count: 1, useExtraInfo: allowed })
    return pos ? bot.blockAt(pos) : null
  }

  // Collect one block, giving up after blockTimeoutMs.
  async function collectOne(block) {
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        bot.collectBlock.cancelTask().catch(() => {})
        reject(Object.assign(new Error(`gave up after ${blockTimeoutMs / 1000}s`), { name: 'BlockTimeout' }))
      }, blockTimeoutMs)
    })
    try {
      await Promise.race([bot.collectBlock.collect(block), timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  function useMovements(movements, { gather }) {
    bot.pathfinder.setMovements(movements)
    bot.collectBlock.movements = movements
    bot.pathfinder.searchRadius = gather ? pathSearchRadius : -1
  }

  function collect({ item, count }) {
    const target = resolveTarget(bot.registry, item)
    if (!target) {
      say(`I don't know how to get "${item}".`)
      return
    }
    count = Math.max(1, Math.min(count ?? 1, maxCount))
    const description = `getting ${count} ${target.label}`

    startTask(description, async (task) => {
      const start = countItems(target.items)
      const got = () => countItems(target.items) - start
      const skipped = new Set()
      let failures = 0
      let reason = null
      let halfwayReported = false
      useMovements(new CompanionMovements(bot, { gather: true }), { gather: true })
      try {
        while (!task.cancelled && got() < count) {
          // Let a survival reflex (backing off, eating, sleeping) finish before carrying on.
          if (survival.busy()) { await sleep(500); continue }
          const block = findBlock(target, skipped)
          if (!block) { reason = `there's no more ${target.label} within ${searchRadius} blocks I'm allowed to dig`; break }
          const tool = missingTool(block)
          if (tool) { reason = `I need a ${tool} to mine ${pretty(block.name)}`; break }
          try {
            await collectOne(block)
            log('INFO', `collected ${block.name} at ${block.position}`)
            failures = 0
          } catch (err) {
            if (task.cancelled) break
            if (err.name === 'NoChests') { reason = 'my inventory is full'; break }
            // A reflex took over mid-dig: not this block's fault, so try it again.
            if (survival.busy()) continue
            log('WARN', `couldn't collect ${block.name} at ${block.position}: ${err.message}`)
            skipped.add(block.position.toString())
            if (++failures >= maxFailures) { reason = `I keep getting stuck reaching the ${target.label}`; break }
          }
          task.progress = `${Math.min(got(), count)}/${count}`
          if (!halfwayReported && count >= 8 && got() >= count / 2 && got() < count) {
            halfwayReported = true
            say(`${got()}/${count} ${target.label} so far.`)
          }
        }
      } finally {
        useMovements(new CompanionMovements(bot), { gather: false })
      }
      if (task.cancelled) return
      const total = got()
      if (total >= count) say(`Got ${count} ${target.label}.`)
      else if (total > 0) say(`I only got ${total} ${target.label}: ${reason}.`)
      else say(`I couldn't get any ${target.label}: ${reason}.`)
    }, {
      log,
      onCancel: () => {
        bot.collectBlock.cancelTask().catch(() => {})
        useMovements(new CompanionMovements(bot), { gather: false })
      },
      onEnd: resume,
    })
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
        await bot.pathfinder.goto(new goals.GoalFollow(player, 2))
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

  return { collect, give }
}
