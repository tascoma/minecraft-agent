// Shared setup for the in-game checks: a second player, ClaudeTester, that types chat and commands
// and watches what the companion bot says. Needs the bot running and a world with cheats on.
// Every check sets the time to day first.
import mineflayer from 'mineflayer'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const stamp = () => new Date().toISOString().slice(11, 19)

export function joinTester(run) {
  const t = mineflayer.createBot({
    host: process.env.MC_HOST ?? 'localhost',
    port: Number(process.env.MC_PORT ?? 25565),
    username: 'ClaudeTester',
    auth: 'offline',
  })
  const companion = process.env.MC_USERNAME ?? 'Claude'
  let failures = 0
  // Names of entities that appeared since the last clearSeen(), e.g. 'arrow'.
  const seen = new Set()
  // Items given to the companion, taken back when the check ends so repeated runs don't fill its inventory.
  const given = []
  t.on('entitySpawn', (e) => seen.add(e.name))

  t.on('chat', (sender, message) => { if (sender === companion) console.log(`${stamp()} <${companion}> ${message}`) })
  t.on('messagestr', (text, position) => { if (position === 'system' && !text.startsWith('<')) console.log(`${stamp()} [server] ${text}`) })

  const helpers = {
    companion,
    // The tester's own Mineflayer bot, for checks that need to read the world directly.
    client: t,
    // Chat as ClaudeTester; the companion treats it like any player's message.
    say(message) { console.log(`${stamp()} <ClaudeTester> ${message}`); t.chat(message) },
    // Give the companion an item for this check; whatever is left of it is cleared at the end.
    give(item, count = 1) {
      given.push([item, count])
      helpers.command(`/give ${companion} ${item} ${count}`)
    },
    command(command) { console.log(`${stamp()} > ${command}`); t.chat(command) },
    // Resolve with the companion's next chat message matching `pattern`, or null after `ms`.
    waitFor(pattern, ms) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => { t.off('chat', onChat); resolve(null) }, ms)
        function onChat(sender, message) {
          if (sender === companion && pattern.test(message)) { clearTimeout(timer); t.off('chat', onChat); resolve(message) }
        }
        t.on('chat', onChat)
      })
    },
    check(name, ok, detail) {
      console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
      if (!ok) failures++
    },
    // An offset like "~3 ~ ~-1" about `distance` blocks from the companion (up to 2 nearer or farther)
    // with room for a mob to stand (two free blocks over solid ground), or null. Mobs summoned into
    // walls suffocate.
    openSpot(distance) {
      const me = t.players[companion]?.entity?.position.floored()
      if (!me) return null
      const free = (pos) => t.blockAt(pos)?.boundingBox === 'empty'
      const tries = [distance, distance - 1, distance + 1, distance - 2, distance + 2].filter((d) => d >= 2)
      for (const d of tries) {
        for (let i = 0; i < 16; i++) {
          const angle = (i / 16) * 2 * Math.PI
          const dx = Math.round(Math.cos(angle) * d)
          const dz = Math.round(Math.sin(angle) * d)
          const feet = me.offset(dx, 0, dz)
          if (free(feet) && free(feet.offset(0, 1, 0)) && !free(feet.offset(0, -1, 0))) return `~${dx} ~ ~${dz}`
        }
      }
      return null
    },
    seen: (name) => seen.has(name),
    clearSeen: () => seen.clear(),
    // The companion's position as the tester sees it.
    position: () => t.players[companion]?.entity?.position.clone() ?? null,
    // True while the companion holds up a shield or draws a bow (the "hand active" flag).
    usingItem: () => Boolean((t.players[companion]?.entity?.metadata?.[8] ?? 0) & 0x01),
    // What the companion holds in its off-hand.
    offHand: () => t.players[companion]?.entity?.equipment?.[1]?.name ?? null,
    // Players near the companion other than the companion bot and the tester.
    playersNear(range = 16) {
      const me = t.players[companion]?.entity
      return Object.values(t.players)
        .filter((p) => p.username !== companion && p.username !== t.username && p.entity && me && p.entity.position.distanceTo(me.position) <= range)
        .map((p) => p.username)
    },
    // How many of a mob are alive within `range` blocks of the companion.
    count(name, range = 24) {
      const me = t.players[companion]?.entity
      return me ? Object.values(t.entities).filter((e) => e.name === name && e.position.distanceTo(me.position) <= range).length : 0
    },
    // How far a mob is from the companion, or null if there isn't one.
    distanceTo(name) {
      const me = t.players[companion]?.entity
      const mob = me && t.nearestEntity((e) => e.name === name)
      return mob ? mob.position.distanceTo(me.position) : null
    },
    // Armor the tester can see on the companion: boots, leggings, chestplate, helmet.
    armor: () => (t.players[companion]?.entity?.equipment ?? []).slice(2, 6).filter(Boolean).map((i) => i.name),
  }

  t.once('spawn', async () => {
    await sleep(2000)
    // Spectators can't pick up items and mobs ignore them, so the tester can't interfere.
    helpers.command('/gamemode spectator ClaudeTester')
    helpers.command(`/tp ClaudeTester ${companion}`)
    // Daylight, so mobs don't attack the bot in the middle of a check.
    helpers.command('/time set day')
    await sleep(2000)
    try {
      await run(helpers)
    } finally {
      // Take back what the check gave (up to the amount given; anything used up is already gone).
      for (const [item, count] of given) helpers.command(`/clear ${companion} ${item} ${count}`)
      if (given.length) await sleep(1000)
      console.log(failures ? `${failures} check(s) failed` : 'all checks passed')
      t.quit()
      process.exitCode = failures ? 1 : 0
    }
  })
  t.on('kicked', (r) => { console.log('kicked', JSON.stringify(r)); process.exit(1) })
  t.on('error', (e) => { console.log('error', e.message); process.exit(1) })
}
