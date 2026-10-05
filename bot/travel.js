// Getting around the bigger world: walking through Nether portals (and following the player through
// one by itself), and throwing an eye of ender to find the stronghold.
import pathfinderPkg from 'mineflayer-pathfinder'
import { startTask } from './tasks.js'
import { goWithin } from './walk.js'

const { goals } = pathfinderPkg

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// How far to look for a portal to walk into, and how long the trip through may take.
const portalRange = 32
const portalWalkMs = 60_000
const crossingMs = 15_000
// Follow the player through a portal they vanished into within this distance of it.
const vanishRange = 2
// How long to watch a thrown eye of ender.
const eyeWatchMs = 2500

const compassPoints = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west']

/** The 8-point compass direction of a horizontal movement, and its bearing (0 north, 90 east). */
export function bearing(dx, dz) {
  const degrees = (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360
  return { degrees: Math.round(degrees), point: compassPoints[Math.round(degrees / 45) % 8] }
}

/**
 * What a thrown eye of ender's path says: { went: 'down' } if it barely moved sideways (the
 * stronghold is right below), else { went: 'away', ...bearing }.
 */
export function readEye(path) {
  const first = path[0]
  const last = path[path.length - 1]
  const dx = last.x - first.x
  const dz = last.z - first.z
  if (Math.hypot(dx, dz) < 1.5) return { went: 'down' }
  return { went: 'away', ...bearing(dx, dz) }
}

export function installTravel(bot, { say, log, survival, following, resume }) {
  const portalIds = ['nether_portal', 'end_portal'].map((n) => bot.registry.blocksByName[n]?.id).filter((id) => id != null)
  const nearestPortal = (around, range) => bot.findBlock({ matching: portalIds, maxDistance: range, point: around })

  // Walk into a portal and wait to come out the other side. Returns true if the dimension changed.
  // The pathfinder won't step into portals (movements.js), so walk up to it and step in by hand.
  async function crossPortal(portal) {
    const from = bot.game.dimension
    const { x, y, z } = portal.position
    await goWithin(bot, new goals.GoalNear(x, y, z, 1), portalWalkMs)
    await bot.lookAt(portal.position.offset(0.5, 0.5, 0.5), true)
    bot.setControlState('forward', true)
    const deadline = Date.now() + crossingMs
    try {
      while (bot.game.dimension === from && Date.now() < deadline) await sleep(250)
    } finally {
      bot.setControlState('forward', false)
    }
    if (bot.game.dimension === from) return false
    // Step out of the portal on the other side, or it can carry the bot straight back.
    await sleep(1500)
    const out = bot.entity.position.floored()
    for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) {
      const spot = out.offset(dx, 0, dz)
      if (bot.blockAt(spot)?.boundingBox === 'empty' && bot.blockAt(spot.offset(0, -1, 0))?.boundingBox === 'block') {
        await goWithin(bot, new goals.GoalBlock(spot.x, spot.y, spot.z), 10_000).catch(() => {})
        break
      }
    }
    return true
  }

  const dimensionName = (d) => `the ${d.replace(/^the_/, '').replaceAll('_', ' ').replace(/^\w/, (c) => c.toUpperCase())}`

  function enterPortal() {
    startTask('going through the portal', async (task) => {
      const portal = nearestPortal(bot.entity.position, portalRange)
      if (!portal) {
        say(`I don't see a portal within ${portalRange} blocks.`)
        return
      }
      try {
        if (await crossPortal(portal)) say(`Made it to ${dimensionName(bot.game.dimension)}.`)
        else if (!task.cancelled) say("I walked into the portal but nothing happened. Is it lit?")
      } catch (err) {
        if (!task.cancelled) say("I can't get to the portal.")
      }
    }, { log, onCancel: () => bot.pathfinder.setGoal(null), onEnd: resume })
  }

  // Follow the player through a portal: when the player being followed vanishes right next to one,
  // go through after them. On the other side the follow picks them up again.
  const lastSeen = new Map()
  bot.on('entityMoved', (e) => {
    if (e.type === 'player' && e.username === following()) lastSeen.set(e.username, e.position.clone())
  })
  bot.on('entityGone', (e) => {
    const name = following()
    if (e.type !== 'player' || e.username !== name) return
    const where = lastSeen.get(name) ?? e.position
    const portal = nearestPortal(where, vanishRange + 1)
    if (!portal || portal.position.offset(0.5, 0, 0.5).distanceTo(where) > vanishRange) return
    // Give it a moment: if they only stepped out of view, they'll be back.
    setTimeout(() => {
      if (bot.players[name]?.entity || following() !== name || survival.busy()) return
      log('INFO', `${name} went through a portal; following`)
      say('Coming through the portal after you!')
      startTask('following through the portal', async (task) => {
        try {
          if (!(await crossPortal(portal)) && !task.cancelled) say("I couldn't get through the portal.")
        } catch {
          if (!task.cancelled) say("I can't get to the portal.")
        }
      }, { log, onCancel: () => bot.pathfinder.setGoal(null), onEnd: resume })
    }, 2000)
  })

  // Throw an eye of ender and say which way it flew.
  function throwEye() {
    startTask('throwing an eye of ender', async () => {
      const eye = bot.inventory.items().find((i) => i.name === 'ender_eye')
      if (!eye) {
        say('I have no eyes of ender. They take a blaze powder and an ender pearl each.')
        return
      }
      if (bot.game.dimension !== 'overworld') {
        say('Eyes of ender only find strongholds in the Overworld.')
        return
      }
      bot.pathfinder.setGoal(null)
      await bot.equip(eye, 'hand')
      await bot.look(bot.entity.yaw, 0.3, true)
      // Watch for the eye to appear next to the bot, then track where it goes.
      const path = []
      let thrown = null
      const onSpawn = (e) => {
        if (e.name === 'eye_of_ender' && e.position.distanceTo(bot.entity.position) < 4) thrown = e
      }
      bot.on('entitySpawn', onSpawn)
      bot.activateItem()
      for (let t = 0; t < eyeWatchMs; t += 100) {
        await sleep(100)
        if (thrown?.isValid) path.push(thrown.position.clone())
      }
      bot.off('entitySpawn', onSpawn)
      if (path.length < 2) {
        say("I threw the eye but lost sight of it. Try again somewhere open.")
        return
      }
      const reading = readEye(path)
      const { x, z } = bot.entity.position.floored()
      if (reading.went === 'down') say(`The eye went straight down at (${x}, ${z}): the stronghold is right below us. Dig down carefully.`)
      else say(`The eye flew ${reading.point} (bearing ${reading.degrees}°) from (${x}, ${z}). Walk that way a few hundred blocks and throw another.`)
      // A thrown eye drops back as an item four times out of five: pick it up.
      await sleep(1500)
      const end = path[path.length - 1]
      const drop = bot.nearestEntity((e) => e.name === 'item' && e.getDroppedItem?.()?.name === 'ender_eye' && e.position.distanceTo(end) < 6)
      if (drop) {
        const p = drop.position
        await goWithin(bot, new goals.GoalNear(p.x, p.y, p.z, 0), 15_000).catch(() => {})
      }
    }, { log, onCancel: () => bot.pathfinder.setGoal(null), onEnd: resume })
  }

  return { enterPortal, throwEye }
}

