// Joins a Minecraft Java server and relays chat to the backend agent.
import mineflayer from 'mineflayer'

const host = process.env.MC_HOST ?? 'localhost'
const port = Number(process.env.MC_PORT ?? 25565)
const username = process.env.MC_USERNAME ?? 'Claude'
const backendUrl = process.env.BACKEND_URL ?? 'http://127.0.0.1:8000'

const bot = mineflayer.createBot({ host, port, username, auth: 'offline' })

bot.once('spawn', () => {
  console.log(`Joined ${host}:${port} as ${username}`)
  bot.chat('Hi! I am here.')
})

bot.on('chat', async (sender, message) => {
  if (sender === bot.username) return
  try {
    const res = await fetch(`${backendUrl}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: sender, message }),
    })
    const { reply } = await res.json()
    // Minecraft chat messages are capped at 256 characters.
    bot.chat(reply.slice(0, 256))
  } catch (err) {
    console.error('Backend request failed:', err)
  }
})

bot.on('kicked', (reason) => console.log('Kicked:', reason))
bot.on('error', (err) => console.error(err))
