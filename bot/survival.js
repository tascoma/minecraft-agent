// Reflexes that keep the bot alive: eating, wearing armor, backing off when hurt, getting out of
// lava, fire and deep water, sleeping when the player sleeps, and fetching its items after dying.
// They run in the bot with no backend call and no tokens.
import pathfinderPkg from 'mineflayer-pathfinder'
import { loader as autoEat } from 'mineflayer-auto-eat'
import armorManager from 'mineflayer-armor-manager'
import { goWithin } from './walk.js'

const { goals } = pathfinderPkg

// Back off from hostile mobs within dangerRange when health is at or below lowHealth.
const lowHealth = 8
const dangerRange = 12
const retreatMs = 5000
// Natural healing needs 18+ food, so top up early while hurt.
const eatBelowWhenHurt = 18
const eatBelow = 14
// At or below this food level with nothing edible, ask the player for food (at most every askForFoodMs).
const starving = 6
const askForFoodMs = 120_000
// Swim up when air drops below this (out of 20).
const lowOxygen = 6
// Dropped items vanish 5 minutes after death.
const itemDespawnMs = 5 * 60_000
const itemPickupRange = 8
const bedRange = 16
// Don't repeat the same reflex announcement more often than this.
const announceMs = 30_000
// Walking back to where it died, and to each dropped item, can't take longer than this.
const recoverWalkMs = 90_000
const pickupWalkMs = 10_000
const bedWalkMs = 60_000

// Where the bot last died. Kept across reconnects so "get my stuff" still works.
let lastDeath = null

export function lastDeathInfo() {
  if (!lastDeath || Date.now() - lastDeath.at > itemDespawnMs) return null
  return { ...lastDeath, secondsAgo: Math.round((Date.now() - lastDeath.at) / 1000) }
}

export function installSurvival(bot, { say, log, companion, resume }) {
  // Which reflex is driving the bot right now, if any: 'retreat', 'escape', 'sleep', 'recover', or
  // combat's 'fight' and 'creeper' (see combat.js).
  let reflex = null
  const lastAnnounced = {}

  function announce(kind, message) {
    const now = Date.now()
    if (now - (lastAnnounced[kind] ?? 0) < announceMs) return
    lastAnnounced[kind] = now
    say(message)
  }

  function start(kind) {
    reflex = kind
    log('INFO', `reflex: ${kind}`)
  }

  // End a reflex and go back to following or standing still. A no-op if another reflex or a
  // player command has taken over since.
  function finish(kind) {
    if (reflex !== kind) return
    reflex = null
    bot.clearControlStates()
    resume()
  }

  // --- Eating -------------------------------------------------------------
  bot.loadPlugin(autoEat)
  // Eat based on the food bar only: a hurt bot with a full bar can't eat and would retry forever.
  bot.autoEat.setOpts({ minHunger: eatBelow, minHealth: 0, strictErrors: false })
  bot.autoEat.enableAuto()
  bot.autoEat.on('eatStart', ({ food }) => log('INFO', `eating ${food.name}`))

  function edible() {
    const { bannedFood } = bot.autoEat.opts
    return bot.inventory.items().filter((i) => bot.autoEat.foodsByName[i.name])
      .filter((i) => !bannedFood.includes(i.name))
  }

  bot.on('health', () => {
    bot.autoEat.setOpts({ minHunger: bot.health < 20 ? eatBelowWhenHurt : eatBelow })
    if (bot.food > starving || bot.autoEat.isEating) return
    if (edible().length > 0) return
    // Nothing good to eat: rotten flesh beats starving.
    const flesh = bot.inventory.items().find((i) => i.name === 'rotten_flesh')
    if (flesh) bot.autoEat.eat({ food: flesh }).catch((err) => log('WARN', `couldn't eat rotten flesh: ${err.message}`))
    else announce('food', "I'm starving and have no food. Could you toss me some?")
  })

  // --- Armor --------------------------------------------------------------
  // Equips the best armor it has now, and anything better it picks up later.
  bot.loadPlugin(armorManager)
  const equipArmor = () => bot.armorManager.equipAll().catch((err) => log('WARN', `couldn't equip armor: ${err.message}`))
  equipArmor()
  // armor-manager only reacts to items picked up off the ground; also catch armor that arrives
  // straight in the inventory (from a chest, crafting or /give).
  let armorCheck = null
  bot.inventory.on('updateSlot', (slot, oldItem, newItem) => {
    if (!newItem || !/_(helmet|chestplate|leggings|boots)$/.test(newItem.name)) return
    clearTimeout(armorCheck)
    armorCheck = setTimeout(equipArmor, 500)
  })

  // --- Backing off when hurt ----------------------------------------------
  function checkDanger() {
    // Getting away matters more than finishing a fight.
    const fighting = reflex === 'fight' || reflex === 'creeper'
    if ((reflex && !fighting) || bot.health > lowHealth || bot.health <= 0) return
    const me = bot.entity.position
    const mob = bot.nearestEntity((e) => e.type === 'hostile' && e.position.distanceTo(me) <= dangerRange)
    if (!mob) return
    // Run to the player if they're farther from the mob than we are; otherwise just get away.
    const player = bot.players[companion()]?.entity
    const toPlayer = player && player.position.distanceTo(mob.position) > me.distanceTo(mob.position)
    start('retreat')
    const goal = toPlayer
      ? new goals.GoalFollow(player, 2)
      : new goals.GoalInvert(new goals.GoalFollow(mob, dangerRange + 4))
    bot.pathfinder.setGoal(goal, true)
    const threat = mob.name.replaceAll('_', ' ')
    announce('retreat', toPlayer ? `Running to you, there's a ${threat}!` : `Backing off from the ${threat}!`)
    setTimeout(() => finish('retreat'), retreatMs)
  }

  // --- Lava, fire and drowning --------------------------------------------
  let swimmingUp = false

  function checkHazards() {
    const entity = bot.entity
    // Bit 0 of the first metadata byte is "on fire".
    const onFire = (entity.metadata?.[0] ?? 0) & 0x01
    if (entity.isInLava) {
      bot.setControlState('jump', true)
      if (reflex !== 'escape') {
        start('escape')
        const { x, y, z } = entity.position.floored()
        bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalNear(x, y, z, 4)))
        announce('lava', "I'm in lava!")
      }
    } else if (onFire && reflex !== 'escape') {
      const water = bot.findBlock({ matching: bot.registry.blocksByName.water.id, maxDistance: 10 })
      if (water) {
        start('escape')
        const { x, y, z } = water.position
        bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, 0))
      }
    } else if (reflex === 'escape' && !onFire) {
      finish('escape')
    }

    // Hold jump to swim up until the bot has its breath back.
    if (entity.isInWater && bot.oxygenLevel < lowOxygen && !swimmingUp) {
      swimmingUp = true
      bot.setControlState('jump', true)
      log('INFO', 'swimming up for air')
    } else if (swimmingUp && (!entity.isInWater || bot.oxygenLevel >= 18)) {
      swimmingUp = false
      bot.setControlState('jump', false)
    }
  }

  const reflexTimer = setInterval(() => {
    if (!bot.entity) return
    checkHazards()
    checkDanger()
  }, 500)
  bot.once('end', () => clearInterval(reflexTimer))

  // --- Sleeping when the player sleeps ------------------------------------
  // On a LAN world every player has to sleep for the night to skip, so the bot must too.
  const bedIds = bot.registry.blocksArray.filter((b) => b.name.endsWith('_bed')).map((b) => b.id)

  bot.on('entitySleep', async (entity) => {
    if (entity.type !== 'player' || entity.username !== companion() || reflex === 'sleep' || bot.isSleeping) return
    const beds = bot.findBlocks({ matching: bedIds, maxDistance: bedRange, count: 20 })
      .map((pos) => bot.blockAt(pos))
      .filter((bed) => bed && !bed.getProperties().occupied)
    if (beds.length === 0) {
      say("I need a free bed nearby to sleep too, or the night won't skip.")
      return
    }
    start('sleep')
    try {
      const { x, y, z } = beds[0].position
      await goWithin(bot, new goals.GoalNear(x, y, z, 2), bedWalkMs)
      await bot.sleep(beds[0])
      log('INFO', 'sleeping')
    } catch (err) {
      if (reflex !== 'sleep') return // a player command took over
      log('WARN', `couldn't sleep: ${err.message}`)
      say(`I can't sleep: ${err.message}`)
      finish('sleep')
    }
  })
  bot.on('wake', () => finish('sleep'))

  // --- Dying and getting items back --------------------------------------
  bot.on('death', () => {
    reflex = null
    swimmingUp = false
    lastDeath = { position: bot.entity.position.floored(), dimension: bot.game.dimension, at: Date.now(), announced: false, picked: 0 }
  })

  // Count everything picked up since dying, including items grabbed on the way back or by
  // respawning right next to them, so "get my stuff" reports what it actually recovered.
  bot.on('playerCollect', (collector) => {
    if (collector === bot.entity && lastDeath) lastDeath.picked++
  })

  bot.on('respawn', () => {
    if (!lastDeath || lastDeath.announced || Date.now() - lastDeath.at > 30_000) return
    lastDeath.announced = true
    const { x, y, z } = lastDeath.position
    say(`I died at (${x}, ${y}, ${z}). Say "get my stuff" in the next 5 minutes and I'll go back for it.`)
  })

  async function collectItems(center) {
    const skipped = new Set() // items it couldn't reach
    for (let i = 0; i < 30 && reflex === 'recover'; i++) {
      const item = bot.nearestEntity((e) => e.name === 'item' && !skipped.has(e.id) && e.position.distanceTo(center) <= itemPickupRange)
      if (!item) break
      const { x, y, z } = item.position.floored()
      try {
        await goWithin(bot, new goals.GoalNear(x, y, z, 0), pickupWalkMs)
        await new Promise((r) => setTimeout(r, 300)) // give the server a moment to hand it over
      } catch (err) {
        if (err.name === 'GoalChanged' || err.name === 'PathStopped') break
        skipped.add(item.id)
      }
    }
  }

  async function recoverItems() {
    if (reflex === 'recover') return // already on it
    const death = lastDeathInfo()
    if (!death) {
      say(lastDeath ? 'My items have despawned by now, sorry.' : "I haven't died recently.")
      return
    }
    if (death.dimension !== bot.game.dimension) {
      say(`My stuff is in the ${death.dimension}, not here.`)
      return
    }
    start('recover')
    const { x, y, z } = death.position
    try {
      await goWithin(bot, new goals.GoalNear(x, y, z, 2), recoverWalkMs)
      await collectItems(death.position)
      if (reflex !== 'recover') return
      const { picked } = lastDeath
      say(picked ? `Got my stuff back (${picked} stacks).` : "I'm there, but my items are gone.")
      lastDeath = null
    } catch (err) {
      if (reflex !== 'recover' || err.name === 'GoalChanged' || err.name === 'PathStopped') return
      log('WARN', `couldn't get back to death spot: ${err.message}`)
      say(`I can't find a way back to my stuff at (${x}, ${y}, ${z}).`)
    } finally {
      finish('recover')
    }
  }

  return {
    // For combat.js, which drives the bot through the same reflex slot.
    current: () => reflex,
    start,
    finish,
    // True while a reflex is moving the bot, so the follow logic doesn't take the wheel back.
    busy: () => reflex !== null,
    // A player command always wins over a reflex.
    cancel() {
      if (!reflex) return
      log('INFO', `reflex ${reflex} cancelled by a command`)
      if (bot.isSleeping) bot.wake().catch(() => {})
      reflex = null
      bot.clearControlStates()
    },
    recoverItems,
  }
}
