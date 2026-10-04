// One long-running job at a time, like "get 20 cobblestone". Starting a new job, or any command
// from the player, cancels the current one. Jobs report progress and results in chat themselves.

let current = null

// What the bot is busy with, for the state snapshot; null when idle.
export function currentTask() {
  return current && { description: current.description, progress: current.progress }
}

/**
 * Runs `run(task)` as the current job. `run` should check `task.cancelled` between steps and
 * may set `task.progress` (e.g. "12/20"). `onCancel` stops whatever the job is doing right now;
 * `onEnd` runs when the job finishes on its own (not when cancelled: whatever cancelled it is
 * already in charge of the bot).
 */
export function startTask(description, run, { log, onCancel, onEnd }) {
  cancelTask()
  const task = { description, progress: null, cancelled: false, onCancel }
  current = task
  log('INFO', `task started: ${description}`)
  Promise.resolve()
    .then(() => run(task))
    .catch((err) => log('ERROR', `task "${description}" failed: ${err.stack ?? err}`))
    .finally(() => {
      log('INFO', `task ${task.cancelled ? 'cancelled' : 'finished'}: ${description}`)
      if (current === task) current = null
      if (!task.cancelled) onEnd?.(task)
    })
}

export function cancelTask() {
  if (!current) return
  const task = current
  current = null
  task.cancelled = true
  task.onCancel?.()
}
