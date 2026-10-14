// Which chat the bot should answer. Alone with one player, everything goes through. With two or more
// players around, people talk to each other, and each of those lines would cost an agent run, so
// only a message that names the bot, or comes soon after the bot spoke to that player, goes through.

const SPECTATOR = 3
const REPLY_WINDOW_MS = 30_000

/**
 * `botName` is a function because the bot's username is only known once it has connected.
 * `players` passed to shouldHandle is Mineflayer's `bot.players` values: { username, gamemode }.
 */
export function createChatterFilter({ botName, now = Date.now, windowMs = REPLY_WINDOW_MS }) {
  const spokeAt = new Map()
  return {
    /** The bot has just said something to this player. */
    spoke(sender) { spokeAt.set(sender, now()) },

    shouldHandle(sender, message, players) {
      const name = botName()
      // Spectators (the in-game checks' tester) don't count as someone else to talk to.
      const others = players.filter((p) => p.username !== name && p.gamemode !== SPECTATOR)
      if (others.length <= 1) return true
      if (name && message.toLowerCase().includes(name.toLowerCase())) return true
      return now() - (spokeAt.get(sender) ?? -Infinity) < windowMs
    },
  }
}
