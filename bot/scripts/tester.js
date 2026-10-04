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

  t.on('chat', (sender, message) => { if (sender === companion) console.log(`${stamp()} <${companion}> ${message}`) })
  t.on('messagestr', (text, position) => { if (position === 'system' && !text.startsWith('<')) console.log(`${stamp()} [server] ${text}`) })

  const helpers = {
    companion,
    // Chat as ClaudeTester; the companion treats it like any player's message.
    say(message) { console.log(`${stamp()} <ClaudeTester> ${message}`); t.chat(message) },
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
      console.log(failures ? `${failures} check(s) failed` : 'all checks passed')
      t.quit()
      process.exitCode = failures ? 1 : 0
    }
  })
  t.on('kicked', (r) => { console.log('kicked', JSON.stringify(r)); process.exit(1) })
  t.on('error', (e) => { console.log('error', e.message); process.exit(1) })
}
