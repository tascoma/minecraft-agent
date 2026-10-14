// How much of the bot's time its own periodic work takes. Wrap a handler in `timed`, and every
// few minutes the bot logs one `perf:` line with each handler's calls, average, slowest call and
// share of one CPU core, plus how late the event loop runs (a bot that falls behind walks and
// fights badly). Cheap enough to leave on: two clock reads per call.
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'

const stats = new Map()
const loopDelay = monitorEventLoopDelay({ resolution: 20 })
let windowStart = performance.now()

function record(name, ms) {
  let s = stats.get(name)
  if (!s) stats.set(name, (s = { calls: 0, totalMs: 0, maxMs: 0 }))
  s.calls++
  s.totalMs += ms
  if (ms > s.maxMs) s.maxMs = ms
}

/** The same function, recording how long each call takes under `name`. Synchronous functions only. */
export function timed(name, fn) {
  return function timedCall(...args) {
    const start = performance.now()
    try {
      return fn.apply(this, args)
    } finally {
      record(name, performance.now() - start)
    }
  }
}

/** Run `fn` once, record its time under `name`, and return what it returned. */
export function measure(name, fn) {
  return timed(name, fn)()
}

/**
 * Everything recorded since the last report, busiest first. Each row: name, calls, avgMs, maxMs and
 * `corePercent` (time spent as a share of the window). Starts a new window.
 */
export function perfReport(now = performance.now()) {
  const windowMs = Math.max(1, now - windowStart)
  const rows = [...stats.entries()]
    .map(([name, s]) => ({
      name,
      calls: s.calls,
      avgMs: s.totalMs / s.calls,
      maxMs: s.maxMs,
      corePercent: (s.totalMs / windowMs) * 100,
    }))
    .sort((a, b) => b.corePercent - a.corePercent)
  const lag = {
    p50Ms: loopDelay.percentile(50) / 1e6,
    p99Ms: loopDelay.percentile(99) / 1e6,
    maxMs: loopDelay.max / 1e6,
  }
  stats.clear()
  loopDelay.reset()
  windowStart = now
  return { windowMs, rows, lag }
}

export function formatPerf({ windowMs, rows, lag }) {
  const parts = rows
    .filter((r) => r.calls > 0)
    .map((r) => `${r.name} ${r.calls}x avg ${r.avgMs.toFixed(2)}ms max ${r.maxMs.toFixed(1)}ms (${r.corePercent.toFixed(2)}% of a core)`)
  const loop = `event loop lag p50 ${lag.p50Ms.toFixed(1)}ms p99 ${lag.p99Ms.toFixed(1)}ms max ${lag.maxMs.toFixed(1)}ms`
  return `perf over ${Math.round(windowMs / 1000)}s: ${parts.join('; ') || 'nothing timed'}; ${loop}`
}

/** Log a perf line every `everyMs`. Returns a function that stops it. */
export function startPerfLog(log, { everyMs = 5 * 60_000 } = {}) {
  loopDelay.enable()
  windowStart = performance.now()
  const timer = setInterval(() => log('INFO', formatPerf(perfReport())), everyMs)
  timer.unref()
  return () => { clearInterval(timer); loopDelay.disable() }
}
