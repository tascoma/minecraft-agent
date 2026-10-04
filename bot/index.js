// Joins a Minecraft Java server and relays chat to the backend agent.
import fs from 'node:fs'
import mineflayer from 'mineflayer'
import pathfinderPkg from 'mineflayer-pathfinder'
import { installAlerts } from './alerts.js'
import { CompanionMovements } from './movements.js'
import { snapshot } from './state.js'

const { pathfinder, goals } = pathfinderPkg

const host = process.env.MC_HOST ?? 'localhost'
const port = Number(process.env.MC_PORT ?? 25565)
const username = process.env.MC_USERNAME ?? 'Claude'
const backendUrl = process.env.BACKEND_URL ?? 'http://127.0.0.1:8000'
// How close the bot tries to stay to the player it follows, in blocks.
const followRange = 3
// How close the bot gets when called over with "come here", in blocks.
const comeRange = 2
// Wait before reconnecting after a disconnect, doubling up to the max while the world stays closed.
const reconnectBaseMs = 5_000
const reconnectMaxMs = 60_000
// How long to wait for the backend; an agent run with several tool calls can take a while.
const backendTimeoutMs = 60_000
// Don't repeat the same error in chat more often than this, so a failure loop can't spam the player.
const errorRepeatMs = 10_000

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
  try {
    // Minecraft chat messages are capped at 256 characters.
    bot.chat(message.slice(0, 256))
    log('INFO', `said: ${message}`)
  } catch (err) {
    log('ERROR', `could not chat "${message}": ${err.message}`)
  }
}

const lastErrorAt = new Map()

// Tell the player something failed. The full error goes to the log.
function reportError(message) {
  const now = Date.now()
  if (now - (lastErrorAt.get(message) ?? 0) < errorRepeatMs) return
  lastErrorAt.set(message, now)
  if (bot?.entity) say(`Error: ${message}`)
}

// Chat-ready message for a failed backend request.
async function backendErrorMessage(err, res) {
  if (err.name === 'TimeoutError') return 'my backend took too long to answer. Try again?'
  if (!res) return `I can't reach my backend at ${backendUrl}. Is it running?`
  // The backend sends {"error": "..."} written for the player; fall back to the status code.
  const body = await res.json().catch(() => ({}))
  return body.error ?? `my backend returned an error (HTTP ${res.status}).`
}

// Username of the player being followed, or null when staying put. Kept across reconnects.
let followTarget = null
// The player the bot is playing with: the first one it followed. Once set, players who join
// later don't pull the bot away, even while it's staying put or walking somewhere.
let companion = null
let spawned = false
let reconnectDelay = reconnectBaseMs
let bot

function updateFollowGoal() {
  const entity = followTarget && bot.players[followTarget]?.entity
  // The player's entity is missing while they're out of range; entitySpawn retries when they come back.
  if (entity) bot.pathfinder.setGoal(new goals.GoalFollow(entity, followRange), true)
}

function follow(name) {
  followTarget = name
  companion ??= name
  log('INFO', `following ${name}`)
  updateFollowGoal()
}

// Stop following or walking anywhere and stand still.
function stay() {
  followTarget = null
  bot.pathfinder.setGoal(null)
  log('INFO', 'staying put')
}

// Walk to a goal once, then stand there. Says in chat how the trip went, so the player
// doesn't have to ask (and it costs no tokens).
async function walkTo(goal, { place, arrived }) {
  followTarget = null
  log('INFO', `walking to ${place}`)
  try {
    await bot.pathfinder.goto(goal)
    log('INFO', `arrived at ${place}`)
    say(arrived)
  } catch (err) {
    // Another order (stay, follow, a new destination) replaced this trip, so there's nothing to report.
    if (err.name === 'GoalChanged' || err.name === 'PathStopped') return
    log('WARN', `could not reach ${place}: ${err.message}`)
    say(`I can't find a way to ${place}.`)
  }
}

function come(name) {
  const entity = bot.players[name]?.entity
  if (!entity) {
    say(`I can't see you, ${name}. Tell me your coordinates and I'll head there.`)
    return
  }
  const { x, y, z } = entity.position.floored()
  walkTo(new goals.GoalNear(x, y, z, comeRange), { place: name, arrived: "I'm here." })
}

function goTo({ x, y, z, label }) {
  const place = label ?? (y == null ? `(${x}, ${z})` : `(${x}, ${y}, ${z})`)
  // Without a height, any block in that column will do.
  const goal = y == null ? new goals.GoalXZ(x, z) : new goals.GoalNear(x, y, z, 1)
  walkTo(goal, { place, arrived: `Made it to ${place}.` })
}

function runAction(action) {
  try {
    if (action.type === 'follow') follow(action.username)
    else if (action.type === 'stay') stay()
    else if (action.type === 'come') come(action.username)
    else if (action.type === 'goto') goTo(action)
    else {
      log('WARN', `unknown action: ${JSON.stringify(action)}`)
      reportError(`I don't know how to do "${action.type}" yet. Is the bot out of date?`)
    }
  } catch (err) {
    log('ERROR', `action ${JSON.stringify(action)} failed: ${err.stack ?? err}`)
    reportError(`I couldn't ${action.type}: ${err.message}`)
  }
}

// Builds the state snapshot, or null if that fails, so a scan bug doesn't stop the bot from chatting.
function safeSnapshot(speaker) {
  try {
    return snapshot(bot, speaker)
  } catch (err) {
    log('ERROR', `state snapshot failed: ${err.stack ?? err}`)
    return null
  }
}

function connect() {
  log('INFO', `connecting to ${host}:${port} as ${username}`)
  bot = mineflayer.createBot({ host, port, username, auth: 'offline' })
  bot.loadPlugin(pathfinder)

  bot.once('spawn', () => {
    log('INFO', `joined ${host}:${port} as ${username}`)
    spawned = true
    reconnectDelay = reconnectBaseMs
    bot.pathfinder.setMovements(new CompanionMovements(bot))
    say('Hi! I am here.')
    // After a reconnect, keep doing what we were doing: follow the same player, or stay put.
    if (followTarget) follow(followTarget)
    else if (!companion) {
      const player = Object.keys(bot.players).find((name) => name !== bot.username)
      if (player) follow(player)
    }
    installAlerts(bot, say)
  })

  bot.on('entitySpawn', (entity) => {
    if (entity.type === 'player' && entity.username === followTarget) updateFollowGoal()
  })

  // Players already online at login are handled in spawn; this catches anyone joining later.
  bot.on('playerJoined', (player) => {
    if (!spawned) return
    if (!companion && player.username !== bot.username) follow(player.username)
  })

  bot.on('chat', async (sender, message) => {
    if (sender === bot.username) return
    log('INFO', `heard ${sender}: ${message}`)
    let res
    try {
      res = await fetch(`${backendUrl}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: sender, message, state: safeSnapshot(sender) }),
        signal: AbortSignal.timeout(backendTimeoutMs),
      })
      if (!res.ok) throw new Error(`backend returned HTTP ${res.status}`)
    } catch (err) {
      log('ERROR', `backend request failed: ${res ? err.message : (err.stack ?? err)}`)
      reportError(await backendErrorMessage(err, res))
      return
    }
    const { reply, actions = [] } = await res.json()
    say(reply)
    actions.forEach(runAction)
  })

  bot.on('death', () => log('WARN', 'died'))
  bot.on('respawn', () => {
    log('INFO', 'respawned')
    updateFollowGoal()
  })
  bot.on('kicked', (reason) => log('WARN', `kicked: ${JSON.stringify(reason)}`))
  bot.on('end', (reason) => {
    log('INFO', `disconnected: ${reason}; reconnecting in ${reconnectDelay / 1000}s`)
    spawned = false
    setTimeout(connect, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 2, reconnectMaxMs)
  })
  bot.on('error', (err) => log('ERROR', err.stack ?? String(err)))
}

// Last resort: keep the bot alive and tell the player, instead of crashing out of the world.
process.on('uncaughtException', (err) => {
  log('ERROR', `uncaught: ${err.stack ?? err}`)
  reportError(`something broke in the bot: ${err.message}`)
})
process.on('unhandledRejection', (err) => {
  log('ERROR', `unhandled rejection: ${err?.stack ?? err}`)
  reportError(`something broke in the bot: ${err?.message ?? err}`)
})

connect()
