// Building jobs: put a block where asked, light up an area with torches, build a shelter or hut
// from a small blueprint, bridge across a gap and pillar up. They all go through one placer that
// builds bottom-up, always against something solid, and fetches materials it runs short of (planks
// from logs, cobblestone by mining). Each runs as a job (see tasks.js) and reports in chat.
import { createRequire } from 'node:module'
import pathfinderPkg from 'mineflayer-pathfinder'
import { startTask } from '../core/tasks.js'
import { goWithin } from '../core/walk.js'

const require = createRequire(import.meta.url)
const { Vec3 } = require('vec3')
const { goals } = pathfinderPkg

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pretty = (name) => name.replace(/^family:/, '').replaceAll('_', ' ')

// Blocks a placed block simply replaces.
const replaceable = new Set(['air', 'cave_air', 'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'snow', 'dead_bush', 'vine'])
// Building blocks the bot will use, best first. "family:planks" is any kind of planks.
const materials = ['cobblestone', 'family:planks', 'cobbled_deepslate', 'stone', 'dirt', 'stone_bricks', 'sandstone', 'blackstone']
// How far the bot can reach to place a block.
const reach = 4
// Torches light 14 at the torch and one less per block; 7 apart leaves no spot below 7.
const torchSpacing = 7
const darkBelow = 8
const maxTorches = 32
const maxLength = 32
// Give up after this many blocks in a row couldn't be placed.
const maxFailures = 5

export const directions = {
  north: new Vec3(0, 0, -1),
  south: new Vec3(0, 0, 1),
  east: new Vec3(1, 0, 0),
  west: new Vec3(-1, 0, 0),
}
// The six neighbours of a block, bottom first: placing on top of something is the most reliable.
const neighbours = [new Vec3(0, -1, 0), ...Object.values(directions), new Vec3(0, 1, 0)]

/** The compass direction closest to a vector (only x and z count). */
export function compass(v) {
  if (Math.abs(v.x) > Math.abs(v.z)) return v.x > 0 ? 'east' : 'west'
  return v.z > 0 ? 'south' : 'north'
}

/** The compass direction someone faces, from a Mineflayer yaw (0 is north, increasing anticlockwise). */
export function facingFromYaw(yaw) {
  return compass(new Vec3(-Math.sin(yaw), 0, -Math.cos(yaw)))
}

// The blueprints: inside size, wall height, and whether there's a floor.
export const blueprints = {
  shelter: { inside: 3, walls: 2, label: 'shelter' },
  hut: { inside: 5, walls: 3, label: 'hut' },
}

/**
 * The blocks of a blueprint around `origin` (the floor-level centre of the inside), with the door
 * in the wall facing `facing`: [{ pos, part: 'wall' | 'roof' | 'door' }]. The door is one entry
 * (its lower half); the cell above it is left out of the wall.
 */
export function layout(kind, origin, facing = 'south') {
  const { inside, walls } = blueprints[kind]
  const edge = (inside - 1) / 2 + 1
  const out = directions[facing]
  const door = origin.plus(out.scaled(edge))
  const blocks = []
  for (let dx = -edge; dx <= edge; dx++) {
    for (let dz = -edge; dz <= edge; dz++) {
      const onWall = Math.abs(dx) === edge || Math.abs(dz) === edge
      for (let y = 0; y < walls && onWall; y++) {
        const pos = origin.offset(dx, y, dz)
        if (pos.x === door.x && pos.z === door.z && y <= 1) {
          if (y === 0) blocks.push({ pos, part: 'door' })
          continue
        }
        blocks.push({ pos, part: 'wall' })
      }
      blocks.push({ pos: origin.offset(dx, walls, dz), part: 'roof' })
    }
  }
  return blocks
}

/**
 * A Nether portal frame standing at `origin` (its bottom-left frame block), 4 wide and 5 tall, along
 * `axis` ('x' or 'z'): [{ pos, part: 'frame' | 'corner' | 'inside' }]. Corners aren't part of a
 * portal but hold the side pillars up while building, so they're placed too, from any block.
 */
export function portalLayout(origin, axis = 'x') {
  const at = (u, y) => (axis === 'x' ? origin.offset(u, y, 0) : origin.offset(0, y, u))
  const cells = []
  for (let u = 0; u < 4; u++) {
    for (let y = 0; y < 5; y++) {
      const side = u === 0 || u === 3
      const end = y === 0 || y === 4
      cells.push({ pos: at(u, y), part: side && end ? 'corner' : side || end ? 'frame' : 'inside' })
    }
  }
  return cells
}

/**
 * Which of `remaining` (block positions) to place next: one that touches something solid, lowest
 * first, then nearest to `from`. -1 when none can be placed yet.
 */
export function nextToPlace(remaining, isSolid, from) {
  let best = -1
  for (let i = 0; i < remaining.length; i++) {
    const pos = remaining[i].pos ?? remaining[i]
    if (!neighbours.some((d) => isSolid(pos.plus(d)))) continue
    if (best === -1) { best = i; continue }
    const other = remaining[best].pos ?? remaining[best]
    if (pos.y < other.y || (pos.y === other.y && pos.distanceTo(from) < other.distanceTo(from))) best = i
  }
  return best
}

/** Torch spots from dark candidates (darkest first): at least `spacing` apart and from any light. */
export function torchSpots(candidates, lights, spacing = torchSpacing, limit = maxTorches) {
  const chosen = []
  for (const pos of candidates) {
    if (chosen.length >= limit) break
    if ([...lights, ...chosen].some((l) => l.distanceTo(pos) < spacing)) continue
    chosen.push(pos)
  }
  return chosen
}

/** The building material the bot has the most of, if it's enough; otherwise null. */
export function pickMaterial(counts, needed) {
  const [best] = materials.map((m) => [m, counts(m)]).sort((a, b) => b[1] - a[1])
  return best && best[1] >= needed ? best[0] : null
}

export function installBuilding(bot, { say, log, survival, crafting, resume }) {
  const solid = (pos) => {
    const b = bot.blockAt(pos)
    return Boolean(b) && b.boundingBox === 'block' && !replaceable.has(b.name)
  }
  const free = (pos) => replaceable.has(bot.blockAt(pos)?.name)
  const me = () => bot.entity.position

  // The inventory item to place for a key ("cobblestone", "family:planks", "torch").
  function itemFor(key) {
    const matches = key === 'family:planks' ? (i) => i.name.endsWith('_planks') : (i) => i.name === key
    return bot.inventory.items().find(matches) ?? null
  }

  async function waitForReflexes(task) {
    while (!task.cancelled && survival.busy()) await sleep(500)
  }

  // Walk somewhere, waiting out reflexes that interrupt and trying again (up to three times).
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

  // True when any part of the bot's body (0.6 wide, 1.8 tall) is inside the block at `pos`: the
  // server refuses a block there. Standing just beside it can still poke into it.
  function standingIn(pos) {
    const p = me()
    const overlaps = (lo, hi, cell) => lo < cell + 1 && hi > cell
    return overlaps(p.x - 0.3, p.x + 0.3, pos.x) && overlaps(p.z - 0.3, p.z + 0.3, pos.z) && overlaps(p.y, p.y + 1.8, pos.y)
  }

  /**
   * Place one block of `key` at `pos`, against whatever solid neighbour it has. Returns false if
   * something solid is already there.
   */
  async function placeAt(task, pos, key, { face } = {}) {
    if (!free(pos)) return false
    if (standingIn(pos)) {
      // Step out of the way first: clear of this block, but stay close.
      await walk(task, () => new goals.GoalInvert(new goals.GoalNear(pos.x, pos.y, pos.z, 1.5)), () => !standingIn(pos), 5000)
    }
    if (me().distanceTo(pos.offset(0.5, 0.5, 0.5)) > reach) {
      await walk(task, () => new goals.GoalNear(pos.x, pos.y, pos.z, reach - 1), () => me().distanceTo(pos.offset(0.5, 0.5, 0.5)) <= reach)
    }
    const item = itemFor(key)
    if (!item) throw new Error(`I ran out of ${pretty(key)}`)
    if (bot.heldItem?.name !== item.name) await bot.equip(item, 'hand')
    const d = face ? face.scaled(-1) : neighbours.find((n) => solid(pos.plus(n)))
    if (!d) throw new Error('nothing solid next to it to build against')
    const reference = bot.blockAt(pos.plus(d))
    await bot.placeBlock(reference, d.scaled(-1))
    return true
  }

  // Place a list of blocks ({ pos, key }) in a sensible order. Returns { placed, reason }.
  async function placeAll(task, blocks) {
    const remaining = blocks.filter((b) => free(b.pos))
    const total = remaining.length
    let placed = 0
    let failures = 0
    const skipped = []
    while (!task.cancelled && remaining.length) {
      await waitForReflexes(task)
      if (task.cancelled) break
      const i = nextToPlace(remaining, solid, me())
      if (i === -1) return { placed, reason: 'some blocks have nothing to rest on' }
      const [block] = remaining.splice(i, 1)
      try {
        if (await placeAt(task, block.pos, block.key)) placed++
        failures = 0
        task.progress = `${placed}/${total}`
      } catch (err) {
        if (task.cancelled) break
        if (/ran out/.test(err.message)) return { placed, reason: err.message }
        log('WARN', `couldn't place ${block.key} at ${block.pos}: ${err.message}`)
        // Try it again later: something (a mob, the bot itself) may have been in the way.
        skipped.push(block)
        if (++failures >= maxFailures) return { placed, reason: `I keep failing to place blocks (${err.message})` }
      }
      if (!remaining.length && skipped.length) remaining.push(...skipped.splice(0).filter((b) => free(b.pos)))
    }
    return { placed, reason: null }
  }

  // Make sure there are `n` of `key`, fetching more if needed. Returns an error message or null.
  async function stockUp(task, key, n) {
    if (crafting.count(key) >= n) return null
    try {
      await crafting.obtainItem(task, key, n)
      return null
    } catch (err) {
      return err.message
    }
  }

  // The material for `needed` blocks: the one asked for, else what the bot has most of, else planks.
  function chooseMaterial(asked, needed) {
    if (asked) {
      const name = asked.toLowerCase().trim().replaceAll(' ', '_')
      if (['wood', 'planks', 'wooden', 'plank'].includes(name)) return 'family:planks'
      if (name === 'stone' || name === 'cobble') return 'cobblestone'
      return bot.registry.itemsByName[name] ? name : null
    }
    return pickMaterial(crafting.count, needed) ?? 'family:planks'
  }

  // The ground under `pos`: the first spot at or below it with solid ground underfoot (a player
  // asking from mid-air or a ledge shouldn't get a building in the air), or above it if `pos` is
  // inside the ground.
  function groundAt(pos) {
    let p = pos.floored()
    for (let i = 0; i < 8 && !free(p); i++) p = p.offset(0, 1, 0)
    for (let i = 0; i < 16 && !solid(p.offset(0, -1, 0)); i++) p = p.offset(0, -1, 0)
    return p
  }

  // Facing for a door: towards the player if they're near, else south.
  function doorFacing(origin, username) {
    const player = username && bot.players[username]?.entity
    return player && player.position.distanceTo(origin) > 1 ? compass(player.position.minus(origin)) : 'south'
  }

  // --- Shelter and hut ----------------------------------------------------
  function build({ target, x, y, z, label, item, username }) {
    const kind = blueprints[target] ? target : target?.includes('hut') || target?.includes('house') ? 'hut' : 'shelter'
    const where = label ?? (x == null ? 'here' : `(${x}, ${y}, ${z})`)
    startTask(`building a ${kind} ${where === 'here' ? 'here' : `at ${where}`}`, async (task) => {
      if (x != null) {
        const site = groundAt(new Vec3(x, y, z))
        try {
          await walk(task, () => new goals.GoalNear(site.x, site.y, site.z, 2), () => me().distanceTo(site) <= 2, 60_000)
        } catch {
          if (!task.cancelled) say(`I can't get to ${where} to build.`)
          return
        }
      }
      const origin = x == null ? me().floored() : groundAt(new Vec3(x, y, z))
      const facing = doorFacing(origin, username)
      const parts = layout(kind, origin, facing)
      const needed = parts.filter((p) => p.part !== 'door' && free(p.pos)).length
      const material = chooseMaterial(item, needed)
      if (!material) {
        say(`I don't know what "${item}" is to build with.`)
        return
      }
      say(`Building a ${kind} out of ${pretty(material)} (${needed} blocks), door facing ${facing}.`)
      const short = await stockUp(task, material, needed)
      if (task.cancelled) return
      if (short) {
        say(`I can't get enough ${pretty(material)}: ${short}.`)
        return
      }
      const door = itemFor('oak_door') ? 'oak_door' : bot.inventory.items().find((i) => i.name.endsWith('_door'))?.name ?? 'oak_door'
      const noDoor = await stockUp(task, door, 1)
      const blocks = parts.filter((p) => p.part !== 'door').map((p) => ({ pos: p.pos, key: material }))
      const { placed, reason } = await placeAll(task, blocks)
      if (task.cancelled) return
      // The door last, once the wall around it is up.
      const doorAt = parts.find((p) => p.part === 'door').pos
      let doorPlaced = false
      if (!noDoor && !reason) {
        try {
          doorPlaced = await placeAt(task, doorAt, door, { face: new Vec3(0, 1, 0) })
        } catch (err) {
          log('WARN', `couldn't place the door at ${doorAt}: ${err.message}`)
        }
      }
      if (reason) say(`I built part of the ${kind} (${placed} blocks) but stopped: ${reason}.`)
      else say(`Built the ${kind}${doorPlaced ? ' with a door' : `, but without a door (${noDoor ?? 'it wouldn\'t go in'})`}.`)
    }, { log, onCancel: () => bot.pathfinder.setGoal(null), onEnd: resume })
  }

  // --- Nether portal ------------------------------------------------------
  function portal({ x, y, z, label, username }) {
    startTask('building a Nether portal', async (task) => {
      // In front of the player (or the bot), across their line of sight so they can walk in.
      const player = username && bot.players[username]?.entity
      const base = groundAt(x != null ? new Vec3(x, y, z) : (player ?? bot.entity).position)
      const facing = player ? facingFromYaw(player.yaw) : 'south'
      const axis = facing === 'north' || facing === 'south' ? 'x' : 'z'
      const ahead = directions[facing].scaled(x != null ? 0 : 3)
      const origin = base.plus(ahead).offset(axis === 'x' ? -1 : 0, 0, axis === 'z' ? -1 : 0)
      const cells = portalLayout(origin, axis)
      if (cells.filter((c) => c.part === 'inside').some((c) => !free(c.pos))) {
        say("There's something in the way where the portal would go; find a clear spot and ask again.")
        return
      }
      const short = await stockUp(task, 'obsidian', 10)
      if (task.cancelled) return
      if (short) {
        say(`I need 10 obsidian for a portal and couldn't get it: ${short}. Obsidian needs a diamond pickaxe, and forms where water meets still lava.`)
        return
      }
      const noFlint = await stockUp(task, 'flint_and_steel', 1)
      if (task.cancelled) return
      // Corners from obsidian if there's enough for all 14, else any building block.
      const corner = crafting.count('obsidian') >= 14 ? 'obsidian' : buildingBlock(4) ?? 'obsidian'
      const blocks = cells.filter((c) => c.part !== 'inside').map((c) => ({ pos: c.pos, key: c.part === 'frame' ? 'obsidian' : corner }))
      const { placed, reason } = await placeAll(task, blocks)
      if (task.cancelled) return
      if (reason) {
        say(`I built part of the portal (${placed} blocks) but stopped: ${reason}.`)
        return
      }
      if (noFlint) {
        say(`The frame is up, but I couldn't get flint and steel to light it: ${noFlint}.`)
        return
      }
      // Light it: fire on top of a bottom frame block, from in front of the frame, never inside it
      // (the portal would carry the bot off to the Nether).
      const bottom = cells.find((c) => c.part === 'frame' && c.pos.y === origin.y).pos
      const front = bottom.offset(axis === 'x' ? 0 : -2, 0, axis === 'x' ? -2 : 0)
      await walk(task, () => new goals.GoalBlock(front.x, front.y, front.z), () => me().floored().equals(front))
      await bot.equip(itemFor('flint_and_steel'), 'hand')
      await bot.activateBlock(bot.blockAt(bottom), new Vec3(0, 1, 0))
      await sleep(1000)
      const lit = cells.some((c) => c.part === 'inside' && bot.blockAt(c.pos)?.name === 'nether_portal')
      const where = `(${bottom.x}, ${bottom.y}, ${bottom.z})`
      say(lit ? `The Nether portal is lit at ${where}. Walk in and I'll follow you through.` : `I built the frame at ${where} but it didn't light. Try lighting the inside with flint and steel.`)
    }, { log, onCancel: () => bot.pathfinder.setGoal(null), onEnd: resume })
  }

  // --- Torches ------------------------------------------------------------
  function lightUp({ count: radius }) {
    radius = Math.max(4, Math.min(radius ?? 16, 32))
    startTask(`lighting up the area`, async (task) => {
      const center = me().floored()
      // Dark ground: an empty block with solid ground under it and little block light.
      const dark = []
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
          for (let dy = -4; dy <= 4; dy++) {
            const pos = center.offset(dx, dy, dz)
            const here = bot.blockAt(pos)
            if (here?.name !== 'air' || !solid(pos.offset(0, -1, 0))) continue
            if (bot.blockAt(pos.offset(0, -1, 0)).name.endsWith('_leaves')) continue
            if ((here.light ?? 0) < darkBelow) dark.push({ pos, light: here.light ?? 0 })
          }
        }
      }
      dark.sort((a, b) => a.light - b.light || a.pos.distanceTo(center) - b.pos.distanceTo(center))
      const lightIds = ['torch', 'wall_torch', 'lantern', 'glowstone', 'jack_o_lantern', 'sea_lantern']
        .map((n) => bot.registry.blocksByName[n]?.id).filter((id) => id != null)
      const lights = bot.findBlocks({ matching: lightIds, maxDistance: radius + torchSpacing, count: 200 })
      const spots = torchSpots(dark.map((d) => d.pos), lights)
      if (spots.length === 0) {
        say(`It's already well lit within ${radius} blocks.`)
        return
      }
      const short = await stockUp(task, 'torch', spots.length)
      if (task.cancelled) return
      const torches = crafting.count('torch')
      if (torches === 0) {
        say(`I need torches and couldn't make any: ${short}.`)
        return
      }
      if (short) say(`I only have ${torches} torches (${short}), placing those.`)
      const { placed, reason } = await placeAll(task, spots.slice(0, torches).map((pos) => ({ pos, key: 'torch' })))
      if (task.cancelled) return
      say(reason ? `Placed ${placed} torches, then stopped: ${reason}.` : `Placed ${placed} torches.`)
    }, { log, onCancel: () => bot.pathfinder.setGoal(null), onEnd: resume })
  }

  // --- One block ----------------------------------------------------------
  // A free spot with solid ground near `around`, nearest first.
  function groundNear(around, avoid = []) {
    const spots = []
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        for (let dy = -2; dy <= 2; dy++) {
          const pos = around.offset(dx, dy, dz)
          if (!free(pos) || !free(pos.offset(0, 1, 0)) || !solid(pos.offset(0, -1, 0))) continue
          if (avoid.some((a) => a.x === pos.x && a.z === pos.z && Math.abs(a.y - pos.y) <= 1)) continue
          spots.push(pos)
        }
      }
    }
    return spots.sort((a, b) => a.distanceTo(around) - b.distanceTo(around))
  }

  function place({ item, x, y, z, label, username }) {
    const name = item?.toLowerCase().trim().replaceAll(' ', '_').replace(/^minecraft:/, '')
    const key = ['planks', 'wood'].includes(name) ? 'family:planks' : name
    if (!key || (!key.startsWith('family:') && !bot.registry.itemsByName[key])) {
      say(`I don't know what "${item}" is.`)
      return
    }
    startTask(`placing ${pretty(key)}`, async (task) => {
      const player = username && bot.players[username]?.entity
      const around = x != null ? new Vec3(x, y, z) : player ? player.position.floored() : me().floored()
      const short = await stockUp(task, key, 1)
      if (task.cancelled) return
      if (short) {
        say(`I don't have ${pretty(key)} and can't make it: ${short}.`)
        return
      }
      // Exactly there if that's free; otherwise the nearest free ground (never on the player).
      const avoid = player ? [player.position.floored()] : []
      const exact = x != null && free(around) && solid(around.offset(0, -1, 0)) ? [around] : []
      for (const spot of [...exact, ...groundNear(around, avoid)].slice(0, 6)) {
        try {
          if (await placeAt(task, spot, key, { face: new Vec3(0, 1, 0) })) {
            const where = label ? ` at ${label}` : ''
            say(`Put down the ${pretty(key)}${where} at (${spot.x}, ${spot.y}, ${spot.z}).`)
            return
          }
        } catch (err) {
          if (task.cancelled) return
          log('WARN', `couldn't place ${key} at ${spot}: ${err.message}`)
        }
      }
      say(`I couldn't find room to put the ${pretty(key)} down.`)
    }, { log, onCancel: () => bot.pathfinder.setGoal(null), onEnd: resume })
  }

  // --- Pillar and bridge --------------------------------------------------
  function buildingBlock(needed) {
    return pickMaterial(crafting.count, needed) ?? pickMaterial(crafting.count, 1)
  }

  function pillar({ count: height }) {
    height = Math.max(1, Math.min(height ?? 5, maxLength))
    startTask(`pillaring up ${height}`, async (task) => {
      const material = buildingBlock(height)
      if (!material) {
        say('I have no blocks to pillar up with.')
        return
      }
      bot.pathfinder.setGoal(null)
      let built = 0
      try {
        while (!task.cancelled && built < height) {
          if (!free(me().floored().offset(0, 2, 0))) { say('Something is in the way above me.'); break }
          const item = itemFor(material)
          if (!item) break
          await bot.equip(item, 'hand')
          await bot.look(bot.entity.yaw, -Math.PI / 2, true)
          const floor = bot.blockAt(me().floored().offset(0, -1, 0))
          const startY = me().y
          // Jump, and place under the feet near the top of the jump (a jump peaks about 1.25 up),
          // still holding jump: the server refuses the block if jump is let go first.
          let risen = false
          for (let tries = 0; tries < 3 && !risen && !task.cancelled; tries++) {
            bot.setControlState('jump', true)
            for (let i = 0; i < 20 && me().y < startY + 1.1; i++) await bot.waitForTicks(1)
            risen = me().y >= startY + 1.1
            if (!risen) { bot.setControlState('jump', false); await sleep(400) } // land and try again
          }
          if (!risen) throw new Error("couldn't jump high enough")
          await bot.waitForTicks(1)
          await bot.placeBlock(floor, new Vec3(0, 1, 0))
          bot.setControlState('jump', false)
          built++
          task.progress = `${built}/${height}`
          await sleep(250)
        }
      } catch (err) {
        if (!task.cancelled) log('WARN', `pillar stopped: ${err.message}`)
      } finally {
        bot.setControlState('jump', false)
      }
      if (task.cancelled) return
      say(built >= height ? `Pillared up ${built} blocks.` : `I got ${built} blocks up.`)
    }, { log, onCancel: () => bot.clearControlStates() })
  }

  function bridge({ target, count: length, username }) {
    length = Math.max(1, Math.min(length ?? 10, maxLength))
    const player = username && bot.players[username]?.entity
    const direction = directions[target?.toLowerCase()] ? target.toLowerCase() : player ? facingFromYaw(player.yaw) : null
    if (!direction) {
      say('Which way? Say north, south, east or west.')
      return
    }
    startTask(`bridging ${length} ${direction}`, async (task) => {
      const material = buildingBlock(length)
      if (!material) {
        say('I have no blocks to bridge with.')
        return
      }
      const step = directions[direction]
      let built = 0
      let walked = 0
      bot.setControlState('sneak', true) // never walk off the edge
      try {
        while (!task.cancelled && walked < length) {
          const feet = me().floored()
          const next = feet.plus(step)
          const under = next.offset(0, -1, 0)
          if (!free(next) || !free(next.offset(0, 1, 0))) { say(`There's something in the way ${direction}.`); break }
          if (!solid(under)) {
            if (!itemFor(material)) break
            await placeAt(task, under, material, { face: step })
            built++
          }
          await walk(task, () => new goals.GoalBlock(next.x, next.y, next.z), () => me().floored().equals(next), 5000)
          walked++
          task.progress = `${walked}/${length}`
        }
      } catch (err) {
        if (!task.cancelled) log('WARN', `bridge stopped: ${err.message}`)
      } finally {
        bot.setControlState('sneak', false)
      }
      if (task.cancelled) return
      say(walked >= length ? `Bridged ${walked} blocks ${direction} (${built} placed).` : `I got ${walked} blocks ${direction} (${built} placed).`)
    }, { log, onCancel: () => { bot.pathfinder.setGoal(null); bot.clearControlStates() } })
  }

  return { build, lightUp, place, pillar, bridge, portal }
}
