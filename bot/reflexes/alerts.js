// Reflexes that warn the player in chat about things that need attention, and offer the odd tip.
// No backend call, no tokens. Creepers near the bot itself are handled (and announced) by combat.js;
// here it's creepers sneaking up on the player.

// Minimum time between two alerts of the same kind, in milliseconds.
const cooldownMs = 30_000
// Tips (not warnings) are spaced out more, so the bot doesn't chatter.
const tipGapMs = 90_000
const lowHealth = 8
// Night mobs start spawning around 13000 ticks; 11800 gives about a minute of warning.
const duskTick = 11800
// A creeper this close to the player, and nearer them than the bot is, gets a warning.
const creeperRange = 5
// Rare ore in view: this close to the player, with at least one open side.
const oreRange = 8
const rareOres = ['diamond_ore', 'deepslate_diamond_ore', 'emerald_ore', 'deepslate_emerald_ore', 'ancient_debris']
// The player's health (entity metadata index 9 for living entities in 1.21) at or below which to say so.
const playerLowHealth = 6

const pretty = (name) => name.replace(/^deepslate_/, '').replaceAll('_', ' ')

/** True if any of the six blocks next to `pos` lets light (and a player's eye) in. */
export function exposed(bot, pos) {
  return [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
    .some(([x, y, z]) => bot.blockAt(pos.offset(x, y, z))?.boundingBox === 'empty')
}

export function installAlerts(bot, say, { companion }) {
  const lastSent = {}
  let lastTip = 0
  // Say `message` unless one of its kind (or, for tips, any tip) went out too recently. True if said.
  function alert(kind, message, { tip = false, cooldown = cooldownMs } = {}) {
    const now = Date.now()
    if (now - (lastSent[kind] ?? 0) < cooldown) return false
    if (tip && now - lastTip < tipGapMs) return false
    lastSent[kind] = now
    if (tip) lastTip = now
    say(message)
    return true
  }

  let wasHurt = false
  bot.on('health', () => {
    // Warn once when health drops below the threshold, again only after it recovers.
    const hurt = bot.health > 0 && bot.health < lowHealth
    if (hurt && !wasHurt) alert('hurt', `I'm hurt! Health ${Math.ceil(bot.health)}/20.`)
    wasHurt = hurt
  })

  let warnedDusk = false
  bot.on('time', () => {
    const t = bot.time.timeOfDay
    if (t >= duskTick && t < 13000 && !warnedDusk) {
      warnedDusk = true
      alert('dusk', "It's getting dark, night in about a minute.")
    } else if (t < duskTick) warnedDusk = false
  })

  // A thunderstorm brings lightning and mobs in daylight: say so once when it starts.
  let thundering = false
  bot.on('weatherUpdate', () => {
    const now = bot.thunderState > 0
    if (now && !thundering) alert('thunder', 'Thunderstorm! Lightning, and mobs can spawn even in daytime. Maybe head inside.', { tip: true })
    thundering = now
  })

  // Rare ore already pointed out, so each block is only mentioned once.
  const pointedOut = new Set()
  const oreIds = rareOres.map((n) => bot.registry.blocksByName[n]?.id).filter((id) => id != null)

  function checkPlayer() {
    const player = bot.players[companion()]?.entity
    if (!player) return
    const me = bot.entity.position

    // A creeper creeping up on the player, closer to them than to the bot (so not already handled).
    const creeper = bot.nearestEntity((e) => e.name === 'creeper' && e.position.distanceTo(player.position) <= creeperRange &&
      e.position.distanceTo(player.position) < e.position.distanceTo(me))
    if (creeper) alert('creeper-player', `${companion()}, creeper right by you!`, { cooldown: 15_000 })

    // The player low on health. Health isn't always sent for other players; skip it if not.
    const health = player.metadata?.[9]
    if (typeof health === 'number' && health > 0 && health <= playerLowHealth) {
      alert('player-hurt', `You're low on health (${Math.ceil(health)}/20). Eat something, or let me handle the fighting.`, { cooldown: 120_000 })
    }

    // Rare ore in view near the player.
    const ore = bot.findBlocks({ matching: oreIds, maxDistance: oreRange, count: 10, point: player.position })
      .map((p) => bot.blockAt(p))
      .find((b) => b && !pointedOut.has(b.position.toString()) && exposed(bot, b.position))
    if (ore) {
      const { x, y, z } = ore.position
      if (alert('ore', `I can see ${pretty(ore.name)} at (${x}, ${y}, ${z})!`, { tip: true, cooldown: 0 })) {
        pointedOut.add(ore.position.toString())
      }
    }
  }

  const timer = setInterval(() => {
    if (bot.entity) checkPlayer()
  }, 1000)
  bot.once('end', () => clearInterval(timer))
}
