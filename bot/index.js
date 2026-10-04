// Joins a Minecraft Java server and relays chat to the backend agent.
import fs from 'node:fs'
import mineflayer from 'mineflayer'
import pathfinderPkg from 'mineflayer-pathfinder'

const { pathfinder, Movements, goals } = pathfinderPkg

const host = process.env.MC_HOST ?? 'localhost'
const port = Number(process.env.MC_PORT ?? 25565)
const username = process.env.MC_USERNAME ?? 'Claude'
const backendUrl = process.env.BACKEND_URL ?? 'http://127.0.0.1:8000'
// How close the bot tries to stay to the player it follows, in blocks.
const followRange = 3

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
bot.loadPlugin(pathfinder)

// Username of the player being followed, or null when staying put.
let followTarget = null
let spawned = false

function updateFollowGoal() {
  const entity = followTarget && bot.players[followTarget]?.entity
  // The player's entity is missing while they're out of range; entitySpawn retries when they come back.
  if (entity) bot.pathfinder.setGoal(new goals.GoalFollow(entity, followRange), true)
}

function follow(name) {
  followTarget = name
  log('INFO', `following ${name}`)
  updateFollowGoal()
}

function stay() {
  followTarget = null
  bot.pathfinder.setGoal(null)
  log('INFO', 'staying put')
}

function runAction(action) {
  if (action.type === 'follow') follow(action.username)
  else if (action.type === 'stay') stay()
  else log('WARN', `unknown action: ${JSON.stringify(action)}`)
}

bot.once('spawn', () => {
  log('INFO', `joined ${host}:${port} as ${username}`)
  spawned = true
  const movements = new Movements(bot)
  movements.canDig = false // don't break the player's builds while walking around
  bot.pathfinder.setMovements(movements)
  say('Hi! I am here.')
  const player = Object.keys(bot.players).find((name) => name !== bot.username)
  if (player) follow(player)
})

bot.on('entitySpawn', (entity) => {
  if (entity.type === 'player' && entity.username === followTarget) updateFollowGoal()
})

// Players already online at login are handled in spawn; this catches anyone joining later.
bot.on('playerJoined', (player) => {
  if (!spawned) return
  if (!followTarget && player.username !== bot.username) follow(player.username)
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
    const { reply, actions = [] } = await res.json()
    actions.forEach(runAction)
    // Minecraft chat messages are capped at 256 characters.
    say(reply.slice(0, 256))
  } catch (err) {
    log('ERROR', `backend request failed: ${err.stack ?? err}`)
  }
})

bot.on('death', () => log('WARN', 'died'))
bot.on('respawn', () => {
  log('INFO', 'respawned')
  updateFollowGoal()
})
bot.on('kicked', (reason) => log('WARN', `kicked: ${JSON.stringify(reason)}`))
bot.on('end', (reason) => log('INFO', `disconnected: ${reason}`))
bot.on('error', (err) => log('ERROR', err.stack ?? String(err)))
