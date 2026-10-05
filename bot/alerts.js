// Reflexes that warn the player in chat about things that need attention. No backend call, no tokens.
// Creepers are handled (and announced) by combat.js.

// Minimum time between two alerts of the same kind, in milliseconds.
const cooldownMs = 30_000
const lowHealth = 8
// Night mobs start spawning around 13000 ticks; 11800 gives about a minute of warning.
const duskTick = 11800

export function installAlerts(bot, say) {
  const lastSent = {}
  function alert(kind, message) {
    const now = Date.now()
    if (now - (lastSent[kind] ?? 0) < cooldownMs) return
    lastSent[kind] = now
    say(message)
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
}
