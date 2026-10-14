// One chat at a time per player. Each message is an agent run, so a player who types three lines
// in two seconds would start three overlapping runs that fight over the same conversation. The
// first line goes straight through (no added delay); lines that arrive while it is being answered
// are joined and sent as one message when it finishes.

/** `handle(sender, message)` answers one message; it should log its own errors. */
export function createChatQueue(handle) {
  const waiting = new Map() // sender -> lines that arrived while a message was being answered

  async function run(sender, first) {
    let message = first
    try {
      while (message !== undefined) {
        try { await handle(sender, message) } catch { /* the handler reports its own failures */ }
        const lines = waiting.get(sender).splice(0)
        message = lines.length ? lines.join('\n') : undefined
      }
    } finally {
      waiting.delete(sender)
    }
  }

  return function push(sender, message) {
    const lines = waiting.get(sender)
    if (lines) { lines.push(message); return Promise.resolve() }
    waiting.set(sender, [])
    return run(sender, message)
  }
}
