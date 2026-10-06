// Walking with a time limit. The pathfinder itself never gives up on a goal it keeps re-planning
// for, so every walk inside a job or reflex goes through here.

// Walk to `goal`, stopping and throwing (name 'WalkTimeout') after `ms`.
export async function goWithin(bot, goal, ms) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      bot.pathfinder.setGoal(null)
      reject(Object.assign(new Error(`took longer than ${ms / 1000}s`), { name: 'WalkTimeout' }))
    }, ms)
  })
  const walk = bot.pathfinder.goto(goal)
  walk.catch(() => {}) // if the timeout wins, the abandoned walk's error doesn't matter
  try {
    await Promise.race([walk, timeout])
  } finally {
    clearTimeout(timer)
  }
}
