// Making things: craft or smelt an item, working out the whole chain as it goes (logs → planks →
// sticks → crafting table → pickaxe), gathering missing materials and making the tools needed to
// gather them. Runs as a job (see tasks.js) and reports in chat.
import { createRequire } from 'node:module'
import pathfinderPkg from 'mineflayer-pathfinder'
import { resolveTarget } from './gathering.js'
import { startTask } from './tasks.js'
import { goWithin } from './walk.js'

const require = createRequire(import.meta.url)
const { Vec3 } = require('vec3')
const { goals } = pathfinderPkg

// Ingredients that recipes treat as interchangeable: a stick can be made from any planks, a stone
// pickaxe from any cobblestone-like block. The planner counts them together and picks the exact
// recipe variant only when crafting, from whatever the bot actually has.
export const families = {
  planks: (name) => name.endsWith('_planks'),
  log: (name) => (name.endsWith('_log') || name.endsWith('_stem')) && !name.startsWith('stripped_'),
  cobble: (name) => ['cobblestone', 'cobbled_deepslate', 'blackstone'].includes(name),
  coal: (name) => name === 'coal' || name === 'charcoal',
}

// Requirement key for an ingredient: "family:planks" for interchangeable ones, else the item name.
export function keyFor(name) {
  const family = Object.keys(families).find((f) => families[f](name))
  return family ? `family:${family}` : name
}

// Furnace recipes (minecraft-data doesn't have them): output → input.
export const smelting = {
  iron_ingot: 'raw_iron',
  gold_ingot: 'raw_gold',
  copper_ingot: 'raw_copper',
  glass: 'sand',
  stone: 'cobblestone',
  smooth_stone: 'stone',
  brick: 'clay_ball',
  charcoal: 'family:log',
  green_dye: 'cactus',
  dried_kelp: 'kelp',
  cooked_beef: 'beef',
  cooked_porkchop: 'porkchop',
  cooked_chicken: 'chicken',
  cooked_mutton: 'mutton',
  cooked_rabbit: 'rabbit',
  cooked_cod: 'cod',
  cooked_salmon: 'salmon',
  baked_potato: 'potato',
}

// How many items one piece of fuel smelts.
export function fuelValue(name) {
  if (name === 'coal' || name === 'charcoal') return 8
  if (name === 'coal_block') return 80
  if (families.log(name) || families.planks(name)) return 1.5
  if (name === 'stick') return 0.5
  return 0
}

/**
 * Picks the recipe variant to plan with: the one the bot can best cover from what it has
 * (`count(key)` gives how many it holds of an item or family), preferring variants made of
 * interchangeable ingredients over odd ones like bamboo.
 */
export function chooseVariant(recipes, registry, count) {
  const score = (recipe) => {
    const needs = requirements(recipe, 1, registry)
    let covered = 0
    let odd = 0
    for (const [key, amount] of needs) {
      covered += Math.min(count(key) / amount, 1)
      if (!key.startsWith('family:') && key !== 'stick') odd++
    }
    return covered * 10 - odd
  }
  return [...recipes].sort((a, b) => score(b) - score(a))[0]
}

// What `times` crafts of `recipe` consume, as a Map of requirement key → amount.
export function requirements(recipe, times, registry) {
  const needs = new Map()
  for (const d of recipe.delta) {
    if (d.count >= 0) continue
    const key = keyFor(registry.items[d.id].name)
    needs.set(key, (needs.get(key) ?? 0) - d.count * times)
  }
  return needs
}

class Missing extends Error {
  name = 'Missing'
}

const pretty = (name) => name.replace(/^family:/, '').replaceAll('_', ' ')

// Things you don't count in English stay as they are: "4 cobblestone", "2 glass".
const massNouns = /(cobblestone|stone|glass|dirt|sand|gravel|coal|charcoal|clay|wool|bread|kelp|brick|iron|gold|copper)$/
export function plural(count, name) {
  const words = pretty(name)
  if (count === 1 || massNouns.test(words)) return `${count} ${words}`
  return `${count} ${/(ch|sh|s|x)$/.test(words) ? `${words}es` : `${words}s`}`
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// Blocks a workstation can be placed into.
const replaceable = new Set(['air', 'cave_air', 'short_grass', 'grass', 'tall_grass', 'fern', 'snow'])
// A job may take this many steps (gathers, crafts, smelts, placements) before it gives up.
const maxSteps = 60
// Use a crafting table or furnace this close by instead of placing one.
const stationRange = 16
const maxCount = 64

export function installCrafting(bot, { say, log, gathering, resume }) {
  const { Recipe } = require('prismarine-recipe')(bot.registry)
  const registry = bot.registry

  const holding = (match) => bot.inventory.items().filter(match).reduce((n, i) => n + i.count, 0)
  const count = (key) => key.startsWith('family:')
    ? holding((i) => families[key.slice(7)](i.name))
    : holding((i) => i.name === key)

  // Everything one job needs: the task (for cancelling) and the stations it placed.
  function maker(task) {
    const placed = [] // workstations this job placed, to pick back up at the end

    // A job never says the same thing twice, so a planning loop can't flood the chat.
    const said = new Set()
    function announce(message) {
      if (said.has(message)) return
      said.add(message)
      say(message)
    }

    function step(what) {
      if (task.cancelled) throw new Missing('cancelled')
      task.steps = (task.steps ?? 0) + 1
      if (task.steps > maxSteps) throw new Missing(`it takes too many steps (stuck on ${what})`)
    }

    // Make sure the bot holds at least `n` of `key` (an item name or "family:..."), by whatever means.
    async function obtain(key, n) {
      if (count(key) >= n) return
      step(pretty(key))
      if (key.startsWith('family:')) return obtainFamily(key.slice(7), n)
      if (smelting[key]) return smelt(key, n)
      if (resolveTarget(registry, key)) return gather(key, n)
      if (registry.itemsByName[key] && Recipe.find(registry.itemsByName[key].id, null).length) return craft(key, n)
      throw new Missing(`I don't know how to get ${pretty(key)}`)
    }

    async function obtainFamily(family, n) {
      const missing = n - count(`family:${family}`)
      if (family === 'planks') {
        // Planks come from whatever logs the bot has; get logs first if it has none.
        const logs = bot.inventory.items().filter((i) => families.log(i.name)).sort((a, b) => b.count - a.count)
        if (logs.length === 0) {
          await obtain('family:log', Math.ceil(missing / 4))
          return obtainFamily(family, n)
        }
        const planks = logs[0].name.replace(/_(log|stem)$/, '_planks')
        return craft(planks, count(planks) + missing)
      }
      const source = { log: 'log', cobble: 'cobblestone', coal: 'coal' }[family]
      return gather(source, n, `family:${family}`)
    }

    // Gather until the bot holds `n` of `countKey` (an item, or a family the gathered item belongs to).
    async function gather(item, n, countKey = item) {
      const missing = n - count(countKey)
      if (missing <= 0) return
      const target = resolveTarget(registry, item)
      announce(`Getting ${missing} ${missing === 1 ? target.label.replace(/s$/, '') : target.label} first.`)
      const { got, reason } = await gathering.gather(task, target, missing)
      if (task.cancelled) throw new Missing('cancelled')
      if (got < missing) throw new Missing(reason)
    }

    async function craft(name, n) {
      const id = registry.itemsByName[name].id
      const recipes = Recipe.find(id, null)
      for (let round = 0; round < 8; round++) {
        const missing = n - count(name)
        if (missing <= 0) return
        step(`crafting ${pretty(name)}`)
        const plan = chooseVariant(recipes, registry, count)
        const times = Math.ceil(missing / plan.result.count)
        // Get the table first: making one uses planks the recipe may also need.
        const table = plan.requiresTable ? await station('crafting_table') : null
        const unmet = [...requirements(plan, times, registry)].find(([key, amount]) => count(key) < amount)
        if (unmet) {
          const [key, amount] = unmet
          const before = count(key)
          await obtain(key, amount)
          if (count(key) <= before) throw new Missing(`I couldn't get more ${pretty(key)}`)
          continue // what we just made may have used up other ingredients; check again
        }
        // Now pick the exact variant from what's in the inventory (oak or birch planks, say).
        if (table) await walkTo(table.position)
        const recipe = bot.recipesFor(id, null, missing, table)[0] ?? bot.recipesFor(id, null, 1, table)[0]
        if (!recipe) throw new Missing(`I have the materials for ${pretty(name)} but couldn't craft it`)
        const doable = Math.max(1, Math.min(times, ...requirementsList(recipe)))
        const using = recipe.delta.filter((d) => d.count < 0)
          .map((d) => `${-d.count * doable} ${registry.items[d.id].name} (have ${bot.inventory.count(d.id, null)})`)
        log('INFO', `crafting ${doable * recipe.result.count} ${name} from ${using.join(', ')}${table ? ' at a table' : ''}`)
        try {
          await bot.craft(recipe, doable, table)
        } catch (err) {
          // Usually the inventory hadn't caught up after the last step; look again and retry.
          log('WARN', `crafting ${name} failed: ${err.message}`)
          await bot.waitForTicks(10)
          continue
        }
        // The server's inventory update can arrive just after craft() returns; let it land before recounting.
        await bot.waitForTicks(4)
        log('INFO', `crafted ${doable * recipe.result.count} ${name}`)
      }
      if (count(name) < n) throw new Missing(`I couldn't make enough ${pretty(name)}`)
    }

    // How many times each ingredient of `recipe` allows it to be crafted, given the inventory.
    function requirementsList(recipe) {
      return recipe.delta.filter((d) => d.count < 0).map((d) => Math.floor(bot.inventory.count(d.id, null) / -d.count))
    }

    async function smelt(output, n) {
      const missing = n - count(output)
      const input = smelting[output]
      await obtain(input, missing)
      const inputItem = bot.inventory.items()
        .filter((i) => (input.startsWith('family:') ? families[input.slice(7)](i.name) : i.name === input))
        .sort((a, b) => b.count - a.count)[0]
      const fuel = await fuelFor(missing, inputItem.name)
      const furnaceBlock = await station('furnace')
      await walkTo(furnaceBlock.position)
      step(`smelting ${pretty(output)}`)
      announce(`Smelting ${missing} ${pretty(inputItem.name)}.`)
      const furnace = await bot.openFurnace(furnaceBlock)
      try {
        await furnace.putFuel(fuel.type, null, fuel.count)
        await furnace.putInput(inputItem.type, null, missing)
        // About 10 seconds per item; allow some slack.
        const deadline = Date.now() + missing * 10_000 + 30_000
        let taken = 0
        while (taken < missing && Date.now() < deadline) {
          if (task.cancelled) throw new Missing('cancelled')
          await sleep(1000)
          const out = furnace.outputItem()
          if (out) taken += (await furnace.takeOutput()).count
        }
        if (taken < missing) throw new Missing(`the furnace stopped after ${taken} ${pretty(output)}`)
      } finally {
        furnace.close()
      }
      log('INFO', `smelted ${missing} ${output}`)
    }

    // Pick fuel for `items` smelts, getting logs if the bot has nothing that burns.
    async function fuelFor(items, inputName) {
      const options = bot.inventory.items()
        .filter((i) => fuelValue(i.name) > 0)
        .map((i) => {
          // The item being smelted can't also be the fuel unless there's enough of it for both.
          const spare = bot.inventory.count(i.type, null) - (i.name === inputName ? items : 0)
          return { type: i.type, name: i.name, count: Math.ceil(items / fuelValue(i.name)), spare }
        })
        .filter((o) => o.spare >= o.count)
        .sort((a, b) => fuelValue(b.name) - fuelValue(a.name))
      if (options[0]) return options[0]
      await obtain('family:log', count('family:log') + Math.ceil(items / 1.5))
      return fuelFor(items, inputName)
    }

    // A crafting table or furnace to use: one nearby, one this job placed, or a new one.
    async function station(name) {
      const id = registry.blocksByName[name].id
      const mine = placed.find((b) => bot.blockAt(b.position)?.name === name)
      if (mine && mine.position.distanceTo(bot.entity.position) < 48) return bot.blockAt(mine.position)
      const nearby = bot.findBlock({ matching: id, maxDistance: stationRange })
      if (nearby) return nearby
      await obtain(name, 1)
      const block = await placeNear(name)
      placed.push(block)
      log('INFO', `placed ${name} at ${block.position}`)
      return block
    }

    // Free spots on solid ground within `radius` of the bot, nearest first.
    function groundSpots(radius) {
      const me = bot.entity.position.floored()
      const spots = []
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
          for (let dy = -2; dy <= 1; dy++) {
            if (dx === 0 && dz === 0) continue // not where the bot stands
            const spot = me.offset(dx, dy, dz)
            const here = bot.blockAt(spot)
            const above = bot.blockAt(spot.offset(0, 1, 0))
            const below = bot.blockAt(spot.offset(0, -1, 0))
            // Only air, or plants and snow that a placed block replaces; not torches, flowers or water.
            if (replaceable.has(here?.name) && above?.boundingBox === 'empty' && below?.boundingBox === 'block' &&
                !below.name.endsWith('_leaves')) {
              spots.push({ spot, below })
            }
          }
        }
      }
      return spots.sort((a, b) => a.spot.distanceTo(me) - b.spot.distanceTo(me))
    }

    // Put a block from the inventory on the ground near the bot. If nothing close works (perched in a
    // tree, say), walk to open ground a little further away and try there.
    async function placeNear(name) {
      step(`placing ${pretty(name)}`)
      for (const radius of [3, 8]) {
        for (const { spot, below } of groundSpots(radius).slice(0, 6)) {
          try {
            if (bot.entity.position.distanceTo(spot) > 3.5) {
              await goWithin(bot, new goals.GoalNear(spot.x, spot.y, spot.z, 2), 30_000)
            }
            await bot.equip(bot.inventory.items().find((i) => i.name === name), 'hand')
            await bot.placeBlock(below, new Vec3(0, 1, 0))
            return bot.blockAt(spot)
          } catch (err) {
            if (task.cancelled) throw new Missing('cancelled')
            log('WARN', `couldn't place ${name} at ${spot}: ${err.message}`)
          }
        }
      }
      throw new Missing(`there's no room to put down a ${pretty(name)}`)
    }

    // Pick up the workstations this job placed. A furnace drops nothing without a pickaxe, so it stays.
    async function cleanUp() {
      for (const placedBlock of placed) {
        const block = bot.blockAt(placedBlock.position)
        if (!block || !['crafting_table', 'furnace'].includes(block.name)) continue
        if (block.name === 'furnace' && !bot.inventory.items().some((i) => i.name.endsWith('_pickaxe'))) {
          const { x, y, z } = block.position
          say(`I left the furnace at (${x}, ${y}, ${z}); I need a pickaxe to pick it up.`)
          continue
        }
        try {
          await walkTo(block.position)
          await bot.tool.equipForBlock(block, {})
          await bot.dig(block)
          // Walk onto the dropped item to pick it up.
          await sleep(300)
          const drop = bot.nearestEntity((e) => e.name === 'item' && e.position.distanceTo(block.position) < 3)
          if (drop) await goWithin(bot, new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0), 10_000)
          log('INFO', `picked up ${block.name} from ${block.position}`)
        } catch (err) {
          log('WARN', `couldn't pick up ${block.name} at ${block.position}: ${err.message}`)
        }
      }
    }

    async function walkTo(pos) {
      if (bot.entity.position.distanceTo(pos) <= 3) return
      await goWithin(bot, new goals.GoalNear(pos.x, pos.y, pos.z, 2), 60_000)
    }

    return { obtain, cleanUp, announce }
  }

  // Gathering asks for this when it needs a tool, e.g. a wooden pickaxe to mine stone. Inside a make
  // job it reuses that job's workstations; on its own (a collect job) it cleans up after itself.
  gathering.setToolMaker(async (task, tool) => {
    const m = task.maker ?? maker(task)
    m.announce(`I need a ${pretty(tool)} for this, making one.`)
    try {
      await m.obtain(tool, 1)
    } finally {
      if (!task.maker) await m.cleanUp()
    }
  })

  function make({ item, count: wanted }) {
    const name = item.toLowerCase().trim().replaceAll(' ', '_').replace(/^minecraft:/, '')
    if (!registry.itemsByName[name]) {
      say(`I don't know what "${item}" is.`)
      return
    }
    wanted = Math.max(1, Math.min(wanted ?? 1, maxCount))

    startTask(`making ${wanted} ${pretty(name)}`, async (task) => {
      const m = maker(task)
      task.maker = m
      const start = count(name)
      let failure = null
      try {
        await m.obtain(name, start + wanted)
      } catch (err) {
        if (task.cancelled) return
        if (err.name !== 'Missing') log('ERROR', `making ${name} failed: ${err.stack ?? err}`)
        failure = err.message
      }
      // Tidy up before reporting, so the player's next request doesn't interrupt the clean-up.
      if (!task.cancelled) await m.cleanUp()
      if (task.cancelled) return
      say(failure ? `I couldn't make ${pretty(name)}: ${failure}.` : `Made ${plural(wanted, name)}.`)
    }, {
      log,
      onCancel: gathering.stop,
      onEnd: resume,
    })
  }

  return { make }
}
