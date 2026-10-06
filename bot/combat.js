// Combat reflexes: fight back when attacked, defend the companion from hostile mobs, back away
// from creepers instead of hitting them, shoot with a bow at range and raise a shield against
// arrows. Also the "attack" command ("kill that zombie") and the guard job. Fights use the survival
// reflex slot, so jobs pause meanwhile and backing off when badly hurt still wins.
// The rules about what may be hit live here, in the bot, not in the agent's instructions.
import pathfinderPkg from 'mineflayer-pathfinder'
import { aimPoint, someoneInTheWay } from './archery.js'
import { startTask } from './tasks.js'
import { goWithin } from './walk.js'

const { goals } = pathfinderPkg

// Never hit these, whatever the player or the model asks: villagers, golems and animals people
// keep as pets or mounts. Players are excluded by type.
const protectedMobs = new Set([
  'villager', 'wandering_trader', 'iron_golem', 'snow_golem', 'allay',
  'wolf', 'cat', 'ocelot', 'parrot', 'fox', 'axolotl',
  'horse', 'donkey', 'mule', 'skeleton_horse', 'zombie_horse', 'llama', 'trader_llama', 'camel',
])
// Hostile-type mobs that leave you alone unless provoked. The bot only fights them when they hurt
// someone; hitting one first starts a fight (and with zombified piglins, a whole group).
const neutralMobs = new Set(['enderman', 'zombified_piglin', 'piglin', 'spider', 'cave_spider'])
// Attack on sight but aren't Mineflayer's 'hostile' type.
const aggressiveOthers = new Set(['phantom', 'slime', 'magma_cube', 'hoglin'])
// Too strong to fight with melee; survival.js backs off from them when the bot gets hurt.
const tooStrong = new Set(['warden', 'wither', 'ender_dragon', 'elder_guardian'])
// Entity types that are creatures. The rest are items, boats, minecarts, frames, armor stands...
const creatureTypes = new Set(['hostile', 'mob', 'animal', 'water_creature', 'ambient'])

// Hit what comes within this range of the bot or the companion, in blocks.
const defendRange = 6
// Ignore mobs more than this far above or below: they're usually in a cave or on a cliff.
const maxHeightGap = 3
// Only defend the companion while they're this close.
const companionRange = 16
// How far the bot can hit, measured between feet (vanilla reach is 3 blocks from the eyes).
const reach = 3
// Give up on a target that gets this far away, or a fight that lasts this long.
const chaseRange = 24
const fightMs = 30_000
// Back away from a creeper this close, until it's at least creeperSafe blocks away.
const creeperRange = 5
const creeperSafe = 9
const creeperMs = 4000
// Low enough that survival.js backs off instead (its lowHealth); don't start fights then.
const lowHealth = 8
const announceMs = 30_000
// Shoot instead of walking up when the target is between these distances and in clear view.
const bowMin = 6
const bowRange = 24
// Hold the bow this long for a full-power shot.
const drawMs = 1100
// Raise the shield for this long when an arrow is flying at the bot.
const blockMs = 1000
// Guarding: fight mobs within this range of the post, and walk back when farther than postSlack.
const guardRange = 12
const postSlack = 2
const postWalkMs = 30_000
const arrows = new Set(['arrow', 'spectral_arrow', 'tipped_arrow'])
// After a fight, pick up what the mob dropped: items that appeared within this range of where it died
// after it died (so never the player's own drops), for at most this long.
const lootRange = 4
const lootMs = 10_000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Damage per second of each weapon, for picking the best one. Swords swing 1.6 times a second,
// axes 0.8 to 1.0 times.
const weaponDps = {
  wooden_sword: 6.4, golden_sword: 6.4, stone_sword: 8, iron_sword: 9.6, diamond_sword: 11.2, netherite_sword: 12.8,
  wooden_axe: 5.6, golden_axe: 7, stone_axe: 7.2, iron_axe: 8.1, diamond_axe: 9, netherite_axe: 10,
}
// Wait this long between hits so each one does full damage.
export const attackCooldownMs = (itemName) =>
  itemName?.endsWith('_sword') ? 650 : itemName?.endsWith('_axe') ? 1100 : 300

const pretty = (name) => name.replaceAll('_', ' ')

// The bot's target right now, for the state snapshot; null when not fighting.
let fightingNow = null
export const currentFight = () => fightingNow

/** True when the bot is allowed to hit this entity at all. */
export function canAttack(entity) {
  return creatureTypes.has(entity?.type) && !protectedMobs.has(entity.name) && !tooStrong.has(entity.name)
}

/** True for anything the bot must never hit, including by a stray arrow. */
export const mustNotHit = (entity) => entity?.type === 'player' || protectedMobs.has(entity?.name)

/** True for mobs that attack on sight, so the bot hits them before they hit anyone. */
export function isAggressive(entity) {
  const attacksOnSight = (entity?.type === 'hostile' && !neutralMobs.has(entity.name)) || aggressiveOthers.has(entity?.name)
  return attacksOnSight && entity.name !== 'creeper' && canAttack(entity)
}

/** The best weapon in a list of inventory items, or null. */
export function bestWeapon(items) {
  return items.filter((i) => weaponDps[i.name]).sort((a, b) => weaponDps[b.name] - weaponDps[a.name])[0] ?? null
}

// "That Cave Spider" -> "cave_spider".
const spokenName = (name) =>
  name?.toLowerCase().trim().replace(/^minecraft:/, '').replace(/^(the|that|this|a|an)\s+/, '').replaceAll(' ', '_')

/** Finds the entity a player means by "zombie", "cow", "that skeleton" or "it": nearest first. */
export function findTarget(entities, me, name) {
  const wanted = spokenName(name)
  const any = !wanted || ['it', 'them', 'mob', 'mobs', 'monster', 'monsters', 'thing', 'one'].includes(wanted)
  return entities
    .filter((e) => canAttack(e) && e.position.distanceTo(me) <= chaseRange)
    .filter((e) => (any ? isAggressive(e) : e.name === wanted || `${e.name}s` === wanted))
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0] ?? null
}

export function installCombat(bot, { say, log, survival, companion }) {
  const lastAnnounced = {}
  function announce(kind, message) {
    const now = Date.now()
    if (now - (lastAnnounced[kind] ?? 0) < announceMs) return
    lastAnnounced[kind] = now
    say(message)
  }

  // The fight in progress: { target, since, lastHit, ordered, shooting, lastChase }.
  let fight = null
  // Where the bot is guarding, while the guard job runs; null otherwise.
  let post = null

  const near = (entity, center, range) =>
    entity.position.distanceTo(center) <= range && Math.abs(entity.position.y - center.y) <= maxHeightGap

  function companionEntity() {
    const player = bot.players[companion()]?.entity
    return player && player.position.distanceTo(bot.entity.position) <= companionRange ? player : null
  }

  // The nearest mob coming for the bot or the companion, or null.
  function nextThreat() {
    const me = bot.entity.position
    const player = companionEntity()
    return bot.nearestEntity((e) => isAggressive(e) && (near(e, me, defendRange) ||
      (player && near(e, player.position, defendRange)) || (post && near(e, post, guardRange))))
  }

  // Free to start a reflex fight: no other reflex (picking up loot doesn't count), and healthy enough to win it.
  const canFight = () => (!survival.current() || survival.current() === 'loot') && bot.health > lowHealth

  async function equipWeapon() {
    const weapon = bestWeapon(bot.inventory.items())
    if (!weapon || bot.heldItem?.name === weapon.name) return
    await bot.equip(weapon, 'hand').catch((err) => log('WARN', `couldn't equip ${weapon.name}: ${err.message}`))
  }

  // --- Bow ----------------------------------------------------------------
  const eye = () => bot.entity.position.offset(0, bot.entity.height ?? 1.62, 0)
  const chest = (entity) => entity.position.offset(0, (entity.height ?? 1.8) * 0.6, 0)
  const hasBow = () => bot.inventory.items().some((i) => i.name === 'bow') &&
    bot.inventory.items().some((i) => arrows.has(i.name))

  // True when an arrow from here could reach `target` without hitting a block or anyone it mustn't.
  function clearShot(target) {
    const from = eye()
    const to = chest(target)
    const direction = to.minus(from)
    const distance = direction.norm()
    if (bot.world.raycast(from, direction.normalize(), distance)) return false
    const others = Object.values(bot.entities).filter((e) => e !== target && e !== bot.entity)
    return !someoneInTheWay(from, to, others, mustNotHit)
  }

  // Draw, aim (leading the target), and loose one arrow. Stands still meanwhile.
  async function shoot(target) {
    fight.shooting = true
    bot.pathfinder.setGoal(null)
    try {
      const bow = bot.inventory.items().find((i) => i.name === 'bow')
      if (bot.heldItem?.name !== 'bow') await bot.equip(bow, 'hand')
      bot.activateItem()
      const until = Date.now() + drawMs
      while (Date.now() < until) {
        const point = aimPoint(eye(), chest(target), target.velocity)
        if (point) await bot.lookAt(point, true)
        await new Promise((r) => setTimeout(r, 100))
      }
      // Something may have walked into the line of fire while drawing.
      if (!fight || fight.target !== target || !target.isValid || !clearShot(target)) {
        bot.deactivateItem()
        return
      }
      const point = aimPoint(eye(), chest(target), target.velocity)
      if (point) await bot.lookAt(point, true)
      bot.deactivateItem()
      log('INFO', `shot at ${target.name} from ${target.position.distanceTo(bot.entity.position).toFixed(0)} blocks`)
    } catch (err) {
      log('WARN', `couldn't shoot: ${err.message}`)
    } finally {
      if (fight) fight.shooting = false
    }
  }

  // --- Shield -------------------------------------------------------------
  let blocking = false
  async function equipShield() {
    const shield = bot.inventory.items().find((i) => i.name === 'shield')
    const offHand = bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')]
    if (!shield || offHand?.name === 'shield') return
    await bot.equip(shield, 'off-hand').catch((err) => log('WARN', `couldn't equip shield: ${err.message}`))
  }
  equipShield()
  let shieldCheck = null
  bot.inventory.on('updateSlot', (slot, oldItem, newItem) => {
    if (newItem?.name !== 'shield') return
    clearTimeout(shieldCheck)
    shieldCheck = setTimeout(equipShield, 500)
  })

  // An arrow flying at the bot (not one it shot), or null.
  function incomingArrow() {
    const me = eye()
    return bot.nearestEntity((e) => {
      if (!arrows.has(e.name) || !e.velocity || e.position.distanceTo(me) > 10) return false
      const v = e.velocity
      const toMe = me.minus(e.position)
      if (v.norm() < 0.1 || v.dot(toMe) <= 0) return false
      // How close it will pass: the distance from the bot to the arrow's line of flight.
      const along = v.dot(toMe) / v.dot(v)
      return toMe.minus(v.scaled(along)).norm() < 1.5
    })
  }

  function checkArrows() {
    if (blocking || fight?.shooting) return
    if (bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')]?.name !== 'shield') return
    const arrow = incomingArrow()
    if (!arrow) return
    blocking = true
    log('INFO', 'raising shield against an arrow')
    bot.lookAt(arrow.position, true).catch(() => {})
    bot.activateItem(true)
    setTimeout(() => { bot.deactivateItem(); blocking = false }, blockMs)
  }

  // Forget the current fight, telling a job waiting on it (kill) whether the target died.
  function dropFight(killed) {
    fight?.resolve?.(killed)
    fight = null
    fightingNow = null
  }

  function startFight(target, { ordered = false, quiet = false, resolve = null, why }) {
    if (fight?.target === target) return
    if (!ordered && !canFight() && survival.current() !== 'fight') return
    if (survival.current() !== 'fight') survival.start('fight')
    dropFight(false)
    fight = { target, since: Date.now(), lastHit: 0, ordered, quiet, resolve }
    fightingNow = target.name
    log('INFO', `fighting ${target.name} (${why})`)
    if (!ordered) announce('fight', `Fighting the ${pretty(target.name)}!`)
    equipWeapon()
    bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true)
  }

  function endFight(message, killed = false) {
    const { target, ordered, quiet } = fight
    dropFight(killed)
    // A quiet fight belongs to a job, which reports how it went itself.
    if (quiet) { survival.finish('fight'); return }
    if (message) say(message)
    else if (ordered) say(`I lost track of the ${pretty(target.name)}.`)
    survival.finish('fight')
  }

  // One step of the fight, run every 100 ms.
  function fightStep() {
    if (survival.current() !== 'fight') { dropFight(false); return } // something else took over
    const { target } = fight
    const me = bot.entity.position
    if (!target.isValid || !bot.entities[target.id]) {
      // Dead or despawned. Remember where, to pick up the drops, and carry on with the next attacker.
      noteKill(target)
      const next = nextThreat()
      const done = fight.ordered && !fight.quiet ? `Got the ${pretty(target.name)}.` : null
      if (next && bot.health > lowHealth) {
        if (done) say(done)
        dropFight(true)
        fight = { target: next, since: Date.now(), lastHit: 0, ordered: false }
        fightingNow = next.name
        log('INFO', `fighting ${next.name} (next attacker)`)
        bot.pathfinder.setGoal(new goals.GoalFollow(next, 2), true)
        return
      }
      endFight(done, true)
      return
    }
    // A guard keeps after anything near its post, however far that is from the bot.
    const inGuardArea = post && near(target, post, guardRange + 4)
    if ((target.position.distanceTo(me) > chaseRange && !inGuardArea) || Date.now() - fight.since > fightMs) {
      log('INFO', `gave up on ${target.name}`)
      endFight()
      return
    }
    if (fight.shooting) return
    const distance = target.position.distanceTo(me)
    if (distance >= bowMin && distance <= bowRange && hasBow() && clearShot(target)) {
      shoot(target)
      return
    }
    // Back to the sword after shooting, or after auto-eat swapped food into the hand.
    const weapon = bestWeapon(bot.inventory.items())
    if (distance <= reach + 2 && weapon && bot.heldItem?.name !== weapon.name && !bot.autoEat?.isEating &&
        Date.now() - (fight.lastEquip ?? 0) > 1000) {
      fight.lastEquip = Date.now()
      equipWeapon()
    }
    // The pathfinder stops once it thinks it has arrived and doesn't notice being knocked back, so
    // if the target is out of reach and nothing is moving the bot, walk to it again.
    if (distance > reach && !bot.pathfinder.isMoving() && Date.now() - (fight.lastChase ?? 0) > 500) {
      fight.lastChase = Date.now()
      bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true)
    }
    const cooldown = attackCooldownMs(bot.heldItem?.name)
    if (distance <= reach && Date.now() - fight.lastHit >= cooldown) {
      fight.lastHit = Date.now()
      const eyes = target.position.offset(0, (target.height ?? 1.6) * 0.8, 0)
      bot.lookAt(eyes, true).catch(() => {})
      bot.attack(target)
    }
  }

  // Back away from a creeper; never hit one (it would just blow up next to the bot).
  function checkCreeper() {
    const me = bot.entity.position
    const creeper = bot.nearestEntity((e) => e.name === 'creeper' && near(e, me, creeperRange))
    if (!creeper) return
    const current = survival.current()
    if (current && current !== 'fight' && current !== 'loot') return
    if (current === 'fight') dropFight(false)
    survival.start('creeper')
    bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(creeper, creeperSafe)), true)
    announce('creeper', 'Creeper! Backing away.')
    setTimeout(() => survival.finish('creeper'), creeperMs)
  }

  // Fight back when hurt, and defend the companion when they're hurt. The damage event names the
  // attacker (for arrows, the skeleton that shot them).
  bot.on('entityHurt', (entity, source) => {
    if (!source || !canAttack(source) || source.name === 'creeper') return
    if (entity === bot.entity) startFight(source, { why: 'it hit me' })
    else if (entity.type === 'player' && entity.username === companion() && companionEntity()) {
      startFight(source, { why: `it hit ${entity.username}` })
    }
  })

  // --- Loot ---------------------------------------------------------------
  // Where mobs died in fights: [{ pos, at }]. Hunting jobs (quiet fights) pick up their own drops.
  const lootSpots = []
  const spawnedAt = new Map()
  bot.on('entitySpawn', (e) => { if (e.name === 'item') spawnedAt.set(e.id, Date.now()) })
  bot.on('entityGone', (e) => spawnedAt.delete(e.id))

  // A mob's drops appear the moment it dies, but it only disappears after its death animation
  // (about a second), so note the moment of death itself.
  const diedAt = new Map()
  bot.on('entityDead', (e) => diedAt.set(e.id, Date.now()))

  function noteKill(target) {
    const at = diedAt.get(target.id) ?? Date.now() - 1500
    diedAt.delete(target.id)
    if (!fight?.quiet) lootSpots.push({ pos: target.position.clone(), at })
  }

  let looting = false
  async function loot() {
    looting = true
    survival.start('loot')
    try {
      const deadline = Date.now() + lootMs
      while (lootSpots.length && Date.now() < deadline && survival.current() === 'loot') {
        const { pos, at } = lootSpots[0]
        const drop = bot.nearestEntity((e) => e.name === 'item' && (spawnedAt.get(e.id) ?? 0) >= at - 250 &&
          e.position.distanceTo(pos) <= lootRange)
        if (!drop) { lootSpots.shift(); continue }
        const p = drop.position
        await goWithin(bot, new goals.GoalNear(p.x, p.y, p.z, 0), 5000).catch(() => spawnedAt.delete(drop.id))
        await sleep(200)
      }
    } finally {
      lootSpots.length = 0
      looting = false
      survival.finish('loot')
    }
  }

  const timer = setInterval(() => {
    if (!bot.entity || bot.health <= 0) return
    checkCreeper()
    checkArrows()
    if (fight) fightStep()
    // Pick up the drops once the fight is over and they've had a moment to land.
    else if (!looting && lootSpots.length && !survival.current() && Date.now() - lootSpots.at(-1).at > 600) loot()
    else if (canFight()) {
      const threat = nextThreat()
      if (threat) {
        startFight(threat, { why: 'it came close' })
      }
    }
  }, 100)
  bot.once('end', () => clearInterval(timer))
  bot.on('death', () => dropFight(false))

  // The guard job: stand at a spot and fight hostile mobs that come near it, going back to the
  // spot after each fight. Runs until the player gives another command.
  function guard({ x, y, z, label }) {
    const where = label ?? `(${x}, ${y}, ${z})`
    startTask(`guarding ${where}`, async (task) => {
      post = bot.entity.position.floored().set(x, y, z)
      say(`Guarding ${where}. I'll fight anything hostile that comes within ${guardRange} blocks.`)
      while (!task.cancelled) {
        await new Promise((r) => setTimeout(r, 1000))
        if (task.cancelled || survival.busy() || fight) continue
        if (bot.entity.position.distanceTo(post) <= postSlack) continue
        try {
          await goWithin(bot, new goals.GoalNear(x, y, z, 1), postWalkMs)
        } catch (err) {
          if (task.cancelled || survival.busy()) continue
          log('WARN', `couldn't get back to guard post ${where}: ${err.message}`)
          say(`I can't get back to ${where}, so I've stopped guarding.`)
          return
        }
      }
    }, {
      log,
      onCancel: () => { post = null },
      onEnd: () => { post = null },
    })
  }

  return {
    guard,
    // For jobs like hunting: fight `target` without any chat. Resolves true when it dies, false
    // when the fight ends otherwise (lost track of it, interrupted, or the bot died).
    kill(target) {
      return new Promise((resolve) => {
        if (!canAttack(target)) { resolve(false); return }
        startFight(target, { ordered: true, quiet: true, resolve, why: 'hunting' })
      })
    },
    // The "attack" command. Players are never hit, and nor are villagers or pets.
    attack({ target: name }) {
      const target = findTarget(Object.values(bot.entities), bot.entity.position, name)
      if (target) {
        startFight(target, { ordered: true, why: 'asked to' })
        return
      }
      const wanted = spokenName(name)
      const named = wanted && Object.values(bot.entities).find((e) => e.name === wanted || e.username?.toLowerCase() === wanted)
      if (named && !canAttack(named)) say(`I won't attack ${named.username ?? `a ${pretty(named.name)}`}.`)
      else say(`I don't see ${name ? `a ${pretty(name)}` : 'anything to fight'} nearby.`)
    },
  }
}
