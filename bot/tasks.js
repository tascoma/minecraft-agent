// One long-running job at a time, like "get 20 cobblestone". Starting a new job, or any command
// from the player, cancels the current one, unless the job is queued: several jobs asked for in one
// reply ("make an iron pickaxe, then a sword") run one after another. Jobs report progress and
// results in chat themselves.

let current = null
// Jobs waiting their turn: { description, run, options }.
const queue = []
// While true, startTask queues a job behind the current one instead of replacing it.
let queueing = false
// Told when each job ends: (task, { cancelled }). Set by index.js to report jobs to the journal.
let onSettled = null

export function setTaskListener(fn) {
  onSettled = fn
}

// What the bot is busy with, for the state snapshot; null when idle.
export function currentTask() {
  return current && { description: current.description, progress: current.progress, queued: queue.length }
}

/** Run `fn` with any job it starts queued behind the current one (or started, if there's none). */
export function queued(fn) {
  queueing = true
  try {
    fn()
  } finally {
    queueing = false
  }
}

/**
 * Runs `run(task)` as the current job. `run` should check `task.cancelled` between steps and
 * may set `task.progress` (e.g. "12/20"). `onCancel` stops whatever the job is doing right now;
 * `onEnd` runs when the job finishes on its own and nothing is queued after it (not when
 * cancelled: whatever cancelled it is already in charge of the bot).
 */
export function startTask(description, run, options) {
  if (queueing && current) {
    queue.push({ description, run, options })
    options.log('INFO', `task queued: ${description}`)
    return
  }
  cancelTask()
  begin(description, run, options)
}

function begin(description, run, { log, onCancel, onEnd }) {
  const task = { description, progress: null, cancelled: false, onCancel }
  current = task
  log('INFO', `task started: ${description}`)
  Promise.resolve()
    .then(() => run(task))
    .catch((err) => log('ERROR', `task "${description}" failed: ${err.stack ?? err}`))
    .finally(() => {
      log('INFO', `task ${task.cancelled ? 'cancelled' : 'finished'}: ${description}`)
      onSettled?.(task, { cancelled: task.cancelled })
      if (current === task) current = null
      if (task.cancelled) return
      const next = queue.shift()
      if (next) begin(next.description, next.run, next.options)
      else onEnd?.(task)
    })
}

/** Stop the current job and drop any queued after it. */
export function cancelTask() {
  queue.length = 0
  if (!current) return
  const task = current
  current = null
  task.cancelled = true
  task.onCancel?.()
}
