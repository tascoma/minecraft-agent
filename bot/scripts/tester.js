// Shared setup for the in-game checks: a second player, ClaudeTester, that types chat and commands
// and watches what the companion bot says. Needs the bot running and a world with cheats on.
// Every check sets the time to day first.
import mineflayer from 'mineflayer'
import { isManMade } from '../movements.js'

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
  // Tools and armor given to the companion, taken back when the check ends so repeated runs don't fill
  // its inventory. Stackable items (blocks, arrows, food) are left: /clear can't tell given cobblestone
  // from the bot's own, and would take its own once the given ones are used up.
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
    // Give the companion an item for this check (tools and armor are taken back at the end).
    give(item, count = 1) {
      if (t.registry.itemsByName[item]?.stackSize === 1) given.push([item, count])
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
    // A patch of natural ground near the companion (within 40 blocks) for building on: cells
    // within `radius` of the centre with grass or dirt underfoot and `height` blocks of air above,
    // and nothing built nearby. Returns { center, level }: level is true when some cells aren't open
    // and the check should flatten the patch first (saveArea before, and restore after). Null if
    // nothing is even mostly open.
    findPatch({ radius, height = 2 }) {
      const start = t.players[companion]?.entity?.position.floored()
      if (!start) return null
      const natural = (name) => ['grass_block', 'dirt', 'podzol', 'coarse_dirt'].includes(name)
      const open = (p) => {
        if (!natural(t.blockAt(p.offset(0, -1, 0))?.name)) return false
        for (let y = 0; y < height; y++) if (t.blockAt(p.offset(0, y, 0))?.boundingBox !== 'empty') return false
        return true
      }
      const untouched = (c) => {
        for (let x = -radius - 2; x <= radius + 2; x++) {
          for (let z = -radius - 2; z <= radius + 2; z++) {
            for (let y = -2; y <= height; y++) if (isManMade(t.blockAt(c.offset(x, y, z))?.name ?? 'air')) return false
          }
        }
        return true
      }
      const cells = (2 * radius + 1) ** 2
      let best = null
      for (let dx = -40; dx <= 40; dx += 2) {
        for (let dz = -40; dz <= 40; dz += 2) {
          for (let dy = -4; dy <= 4; dy++) {
            const c = start.offset(dx, dy, dz)
            let good = 0
            for (let x = -radius; x <= radius; x++) for (let z = -radius; z <= radius; z++) if (open(c.offset(x, 0, z))) good++
            const near = Math.hypot(dx, dz)
            if (good < cells * 0.8 || (best && (good < best.good || (good === best.good && near >= best.near)))) continue
            if (untouched(c)) best = { center: c, good, near }
          }
        }
      }
      return best && { center: best.center, level: best.good < cells }
    },
    // Record every block (with its state) in a box around `center`; the returned function puts them
    // all back exactly and clears dropped items there.
    saveArea(center, radius, down, up) {
      const saved = []
      const state = (b) => {
        if (!b) return 'air'
        const props = Object.entries(b.getProperties())
        return props.length ? `${b.name}[${props.map(([k, v]) => `${k}=${v}`).join(',')}]` : b.name
      }
      for (let x = -radius; x <= radius; x++) {
        for (let z = -radius; z <= radius; z++) {
          for (let y = -down; y <= up; y++) {
            const p = center.offset(x, y, z)
            saved.push([p, state(t.blockAt(p))])
          }
        }
      }
      return async () => {
        // Top down, so nothing placed on top of a changed block pops off as an item first.
        for (const [p, s] of [...saved].reverse()) {
          if (state(t.blockAt(p)) !== s) { helpers.command(`/setblock ${p.x} ${p.y} ${p.z} ${s}`); await sleep(60) }
        }
        helpers.command(`/kill @e[type=item,x=${center.x},y=${center.y},z=${center.z},distance=..${radius + 3}]`)
      }
    },
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
