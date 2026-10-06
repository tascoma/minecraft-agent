// Everything the bot asks of, or tells, the backend over HTTP. Only /chat (and an event the agent
// is asked to react to) runs the agent; the rest is bookkeeping and costs nothing.
import { log } from './log.js'
import { currentWorldId } from './world.js'

export const backendUrl = process.env.BACKEND_URL ?? 'http://127.0.0.1:8000'
// How long to wait for the agent; a run with several tool calls can take a while.
const agentTimeoutMs = 60_000
// Bookkeeping calls should be quick.
const quickMs = 5000

const worldQuery = () => (currentWorldId() ? `?world=${encodeURIComponent(currentWorldId())}` : '')

/** fetch hides the real reason (refused, reset, ...) in err.cause. */
export function describeFetchError(err) {
  const cause = err.cause
  return cause ? `${err.message}: ${cause.code ?? cause.message}` : err.message
}

const post = (path, body, ms) => fetch(`${backendUrl}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(ms),
})

async function getJson(path) {
  const res = await fetch(`${backendUrl}${path}`, { signal: AbortSignal.timeout(quickMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/**
 * Send a player's chat (with the bot's state) to the agent; returns the fetch Response. Retries
 * once if the connection fails before any response: a kept-alive connection the server closed just
 * as it was reused, so the backend never saw the request and sending it again is safe.
 */
export async function postChat(body) {
  try {
    return await post('/chat', body, agentTimeoutMs)
  } catch (err) {
    if (err.name === 'TimeoutError') throw err
    log('WARN', `backend request failed (${describeFetchError(err)}), retrying once`)
    return await post('/chat', body, agentTimeoutMs)
  }
}

/** Chat-ready message for a failed /chat request. */
export async function backendErrorMessage(err, res) {
  if (err.name === 'TimeoutError') return 'my backend took too long to answer. Try again?'
  if (!res) return `I can't reach my backend at ${backendUrl}. Is it running?`
  // The backend sends {"error": "..."} written for the player; fall back to the status code.
  const body = await res.json().catch(() => ({}))
  return body.error ?? `my backend returned an error (HTTP ${res.status}).`
}

/** This world's saved places, or null if the backend couldn't be reached. */
export async function fetchPlaces() {
  try {
    return await getJson(`/places${worldQuery()}`)
  } catch (err) {
    log('WARN', `couldn't load saved places from the backend (${describeFetchError(err)}); none protected until the next chat`)
    return null
  }
}

/** The chests the bot remembers in this world, or null if the backend couldn't be reached. */
export async function fetchChests() {
  try {
    return await getJson(`/chests${worldQuery()}`)
  } catch (err) {
    log('WARN', `couldn't load remembered chests from the backend (${describeFetchError(err)})`)
    return null
  }
}

/** What's in a chest the bot just opened. Fire and forget: a lost update only makes the agent's answer stale. */
export function reportChest(chest) {
  post(`/chests${worldQuery()}`, chest, quickMs)
    .catch((err) => log('WARN', `couldn't report a chest to the backend (${describeFetchError(err)})`))
}

/** A remembered chest that turned out to be gone. */
export function forgetChest({ x, y, z, dimension }) {
  const query = new URLSearchParams({ x, y, z, dimension, ...(currentWorldId() ? { world: currentWorldId() } : {}) })
  fetch(`${backendUrl}/chests?${query}`, { method: 'DELETE', signal: AbortSignal.timeout(quickMs) })
    .catch((err) => log('WARN', `couldn't tell the backend a chest is gone (${describeFetchError(err)})`))
}

/**
 * Something that happened, for the agent's journal. With `react` (and the reaction fields in
 * `body`), the backend may run the agent on it: returns its { reply, actions }, or null.
 */
export async function postEvent(body) {
  try {
    const res = await post(`/events${worldQuery()}`, body, body.react ? agentTimeoutMs : quickMs)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return body.react ? await res.json() : null
  } catch (err) {
    log('WARN', `couldn't report an event to the backend (${describeFetchError(err)})`)
    return null
  }
}
