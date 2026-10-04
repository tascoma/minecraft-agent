// Joins a Minecraft Java server and relays chat to the backend agent.
import fs from 'node:fs'
import mineflayer from 'mineflayer'

const host = process.env.MC_HOST ?? 'localhost'
const port = Number(process.env.MC_PORT ?? 25565)
const username = process.env.MC_USERNAME ?? 'Claude'
const backendUrl = process.env.BACKEND_URL ?? 'http://127.0.0.1:8000'

// Bot actions go to backend/logs/bot.log, next to the agent's own log.
const logDir = new URL('../backend/logs/', import.meta.url)
fs.mkdirSync(logDir, { recursive: true })
const logFile = fs.createWriteStream(new URL('bot.log', logDir), { flags: 'a' })

function log(level, message) {
  const line = `${new Date().toISOString()} ${level} bot: ${message}`
  logFile.write(line + '\n')
  ;(level === 'ERROR' ? console.error : console.log)(line)
}

function say(message) {
  bot.chat(message)
  log('INFO', `said: ${message}`)
}

log('INFO', `connecting to ${host}:${port} as ${username}`)
const bot = mineflayer.createBot({ host, port, username, auth: 'offline' })

bot.once('spawn', () => {
  log('INFO', `joined ${host}:${port} as ${username}`)
  say('Hi! I am here.')
})

bot.on('chat', async (sender, message) => {
  if (sender === bot.username) return
  log('INFO', `heard ${sender}: ${message}`)
  try {
    const res = await fetch(`${backendUrl}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: sender, message }),
    })
    if (!res.ok) throw new Error(`backend returned ${res.status}`)
    const { reply } = await res.json()
    // Minecraft chat messages are capped at 256 characters.
    say(reply.slice(0, 256))
  } catch (err) {
    log('ERROR', `backend request failed: ${err.stack ?? err}`)
  }
})

bot.on('death', () => log('WARN', 'died'))
bot.on('respawn', () => log('INFO', 'respawned'))
bot.on('kicked', (reason) => log('WARN', `kicked: ${JSON.stringify(reason)}`))
bot.on('end', (reason) => log('INFO', `disconnected: ${reason}`))
bot.on('error', (err) => log('ERROR', err.stack ?? String(err)))
