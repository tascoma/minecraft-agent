// Joins a Minecraft Java server and relays chat to the backend agent.
import fs from 'node:fs'
import mineflayer from 'mineflayer'
import pathfinderPkg from 'mineflayer-pathfinder'
import { installAlerts } from './alerts.js'
import { installBuilding } from './building.js'
import { installCombat } from './combat.js'
import { installCrafting } from './crafting.js'
import { installFarming } from './farming.js'
import { installGathering } from './gathering.js'
import { CompanionMovements, setProtectedSpots } from './movements.js'
import { snapshot } from './state.js'
import { installSurvival } from './survival.js'
import { cancelTask, currentTask } from './tasks.js'
import { currentWorldId, setWorldFromLogin } from './world.js'

const { pathfinder, goals } = pathfinderPkg

const host = process.env.MC_HOST ?? 'localhost'
const port = Number(process.env.MC_PORT ?? 25565)
const username = process.env.MC_USERNAME ?? 'Claude'
// Names the world instead of using its seed hash (e.g. when two worlds share a seed).
const worldOverride = process.env.MC_WORLD
const backendUrl = process.env.BACKEND_URL ?? 'http://127.0.0.1:8000'
// How close the bot tries to stay to the player it follows, in blocks.
const followRange = 3
// How close the bot gets when called over with "come here", in blocks.
const comeRange = 2
// How long to wait for the server to move the bot after /tp before assuming it failed.
const teleportTimeoutMs = 3000
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

// POST to the backend, retrying once if the connection fails before any response. That happens
// when a kept-alive connection was closed by the server just as it was reused; the backend never
// saw the request, so sending it again is safe.
async function postChat(body) {
  const request = () =>
    fetch(`${backendUrl}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(backendTimeoutMs),
    })
  try {
    return await request()
  } catch (err) {
    if (err.name === 'TimeoutError') throw err
    log('WARN', `backend request failed (${describeFetchError(err)}), retrying once`)
    return await request()
  }
}

// fetch hides the real reason (refused, reset, ...) in err.cause.
function describeFetchError(err) {
  const cause = err.cause
  return cause ? `${err.message}: ${cause.code ?? cause.message}` : err.message
}

const worldQuery = () => (currentWorldId() ? `?world=${encodeURIComponent(currentWorldId())}` : '')

// Load the saved places so the no-digging zones are right before anyone chats. Chat replies keep
// them up to date after that.
async function loadProtectedSpots() {
  try {
    const res = await fetch(`${backendUrl}/places${worldQuery()}`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const spots = await res.json()
    setProtectedSpots(spots)
    log('INFO', `protecting ${spots.length} saved place(s) from digging`)
  } catch (err) {
    log('WARN', `couldn't load saved places from the backend (${describeFetchError(err)}); none protected until the next chat`)
  }
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
// Survival reflexes and gathering jobs for the current connection (see survival.js, gathering.js).
let survival = null
let gathering = null
let crafting = null
let combat = null
let farming = null
let building = null

function updateFollowGoal() {
  // A reflex (backing off, sleeping, fetching items) or a job (gathering) is driving; it resumes
  // following when done.
  if (survival?.busy() || currentTask()) return
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

// Teleport next to a player with /tp. Needs commands allowed: "Allow Cheats" when opening to LAN,
// or op on a server. Keeps following if it was following; otherwise cancels any trip and waits there.
function teleport(name) {
  if (!followTarget) bot.pathfinder.setGoal(null)
  let serverReply = null
  const onMessage = (text, position) => {
    if (position === 'system' || position === 'game_info') serverReply ??= text
  }
  const onMoved = () => finish(true)
  const timer = setTimeout(() => finish(false), teleportTimeoutMs)
  function finish(moved) {
    clearTimeout(timer)
    bot.off('forcedMove', onMoved)
    bot.off('messagestr', onMessage)
    if (moved) {
      log('INFO', `teleported to ${name}`)
      say("I'm here.")
      return
    }
    log('WARN', `teleport to ${name} failed; server said: ${serverReply ?? 'nothing'}`)
    say("I couldn't teleport. Commands need to be allowed (Open to LAN, Allow Cheats: ON).")
  }
  bot.on('forcedMove', onMoved)
  bot.on('messagestr', onMessage)
  log('INFO', `teleporting to ${name}`)
  bot.chat(`/tp ${name}`)
}

function goTo({ x, y, z, label }) {
  const place = label ?? (y == null ? `(${x}, ${z})` : `(${x}, ${y}, ${z})`)
  // Without a height, any block in that column will do.
  const goal = y == null ? new goals.GoalXZ(x, z) : new goals.GoalNear(x, y, z, 1)
  walkTo(goal, { place, arrived: `Made it to ${place}.` })
}

// Go back to what the player last asked for after a reflex or job is done. If a job is still
// running (a reflex interrupted it), the job carries on by itself.
function resume() {
  if (currentTask()) return
  if (followTarget) updateFollowGoal()
  else bot.pathfinder.setGoal(null)
}

function runAction(action) {
  try {
    // The player's command wins over whatever reflex or job is running.
    survival?.cancel()
    cancelTask()
    if (action.type === 'follow') follow(action.username)
    else if (action.type === 'stay') stay()
    else if (action.type === 'come') come(action.username)
    else if (action.type === 'goto') goTo(action)
    else if (action.type === 'teleport') teleport(action.username)
    else if (action.type === 'recover') survival.recoverItems()
    else if (action.type === 'collect') gathering.collect(action)
    else if (action.type === 'give') gathering.give(action)
    else if (action.type === 'make') crafting.make(action)
    else if (action.type === 'attack') combat.attack(action)
    else if (action.type === 'guard') combat.guard(action)
    else if (action.type === 'hunt') farming.hunt(action)
    else if (action.type === 'harvest') farming.harvest(action)
    else if (action.type === 'plant') farming.plant(action)
    else if (action.type === 'breed') farming.breed(action)
    else if (action.type === 'fish') farming.fish(action)
    else if (action.type === 'shear') farming.shear(action)
    else if (action.type === 'build') building.build(action)
    else if (action.type === 'light') building.lightUp(action)
    else if (action.type === 'place') building.place(action)
    else if (action.type === 'pillar') building.pillar(action)
    else if (action.type === 'bridge') building.bridge(action)
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
  bot._client.on('login', (packet) => {
    log('INFO', `world: ${setWorldFromLogin(packet, { override: worldOverride, host, port })}`)
  })

  bot.once('spawn', () => {
    log('INFO', `joined ${host}:${port} as ${username}`)
    spawned = true
    reconnectDelay = reconnectBaseMs
    bot.pathfinder.setMovements(new CompanionMovements(bot))
    loadProtectedSpots()
    say('Hi! I am here.')
    // After a reconnect, keep doing what we were doing: follow the same player, or stay put.
    if (followTarget) follow(followTarget)
    else if (!companion) {
      const player = Object.keys(bot.players).find((name) => name !== bot.username)
      if (player) follow(player)
    }
    installAlerts(bot, say)
    survival = installSurvival(bot, { say, log, companion: () => companion, resume })
    combat = installCombat(bot, { say, log, survival, companion: () => companion })
    gathering = installGathering(bot, { say, log, survival, resume })
    crafting = installCrafting(bot, { say, log, gathering, resume })
    farming = installFarming(bot, { say, log, survival, combat, gathering, crafting, resume })
    building = installBuilding(bot, { say, log, survival, crafting, resume })
  })

  bot.on('entitySpawn', (entity) => {
    if (entity.type === 'player' && entity.username === followTarget) updateFollowGoal()
  })

  // Players already online at login are handled in spawn; this catches anyone joining later.
  bot.on('playerJoined', (player) => {
    if (!spawned) return
    if (!companion && player.username !== bot.username) follow(player.username)
  })

  // Only real player chat. Mineflayer's 'chat' event also matches server lines like
  // "[Steve: Gave 16 [Bread] to Claude]" that every op sees when someone runs a command,
  // and each of those would cost an agent run.
  bot._client.on('playerChat', ({ sender: uuid, plainMessage }) => {
    const sender = Object.values(bot.players).find((p) => p.uuid === uuid)?.username
    if (!sender || sender === bot.username || !plainMessage) return
    handleChat(sender, plainMessage)
  })

  async function handleChat(sender, message) {
    log('INFO', `heard ${sender}: ${message}`)
    let res
    try {
      res = await postChat({ username: sender, message, state: safeSnapshot(sender) })
      if (!res.ok) throw new Error(`backend returned HTTP ${res.status}`)
    } catch (err) {
      log('ERROR', `backend request failed: ${res ? err.message : describeFetchError(err)}`)
      reportError(await backendErrorMessage(err, res))
      return
    }
    const { reply, actions = [], protected_places: protectedPlaces } = await res.json()
    setProtectedSpots(protectedPlaces)
    say(reply)
    actions.forEach(runAction)
  }

  bot.on('death', () => {
    log('WARN', 'died')
    // The items are gone and the bot respawns far away; a job can't sensibly carry on.
    cancelTask()
  })
  bot.on('respawn', () => {
    log('INFO', 'respawned')
    updateFollowGoal()
  })
  bot.on('kicked', (reason) => log('WARN', `kicked: ${JSON.stringify(reason)}`))
  bot.on('end', (reason) => {
    cancelTask()
    log('INFO', `disconnected: ${reason}; reconnecting in ${reconnectDelay / 1000}s`)
    spawned = false
    setTimeout(connect, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 2, reconnectMaxMs)
  })
  bot.on('error', (err) => log('ERROR', err.stack ?? String(err)))
}

// Last resort: keep the bot alive and tell the player, instead of crashing out of the world.
// A bug in a tick handler throws 20 times a second, so log each distinct error at most every errorRepeatMs.
const lastCrashLogAt = new Map()
function reportCrash(kind, err) {
  const message = err?.message ?? String(err)
  const now = Date.now()
  if (now - (lastCrashLogAt.get(message) ?? 0) >= errorRepeatMs) {
    lastCrashLogAt.set(message, now)
    log('ERROR', `${kind}: ${err?.stack ?? err}`)
  }
  reportError(`something broke in the bot: ${message}`)
}
process.on('uncaughtException', (err) => reportCrash('uncaught', err))
process.on('unhandledRejection', (err) => reportCrash('unhandled rejection', err))

connect()
