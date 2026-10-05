// Trading with villagers: say what a villager offers, and buy an item from whichever villager
// nearby sells it.
import pathfinderPkg from 'mineflayer-pathfinder'
import { itemMatches } from './storage.js'
import { startTask } from './tasks.js'
import { goWithin } from './walk.js'

const { goals } = pathfinderPkg

const traders = ['villager', 'wandering_trader']
const villagerRange = 16
// Say at most this many trades in chat.
const listedTrades = 6

const pretty = (name) => name.replaceAll('_', ' ')

// What a trade costs once: the first input at its current price (discounts and demand change it).
const firstCost = (trade) => trade.realPrice ?? trade.inputItem1.count

/** "12 emerald → 1 iron pickaxe", or with a second input "1 emerald + 1 book → ...". */
export function describeTrade(trade) {
  const first = `${firstCost(trade)} ${pretty(trade.inputItem1.name)}`
  const second = trade.hasItem2 && trade.inputItem2 ? ` + ${trade.inputItem2.count} ${pretty(trade.inputItem2.name)}` : ''
  const out = `${trade.outputItem.count} ${pretty(trade.outputItem.name)}`
  return `${first}${second} → ${out}${trade.tradeDisabled ? ' (sold out)' : ''}`
}

/** How many times a trade can be made with what's in the inventory (`have(name)`), up to `wanted`. */
export function affordableTimes(trade, have, wanted) {
  if (trade.tradeDisabled) return 0
  let times = Math.floor(have(trade.inputItem1.name) / firstCost(trade))
  if (trade.hasItem2 && trade.inputItem2) times = Math.min(times, Math.floor(have(trade.inputItem2.name) / trade.inputItem2.count))
  const left = (trade.maximumNbTradeUses ?? Infinity) - (trade.nbTradeUses ?? 0)
  return Math.max(0, Math.min(times, wanted, left))
}

export function installTrading(bot, { say, log, resume }) {
  const have = (name) => bot.inventory.items().filter((i) => i.name === name).reduce((n, i) => n + i.count, 0)

  const villagersNearby = () => Object.values(bot.entities)
    .filter((e) => traders.includes(e.name) && e.position.distanceTo(bot.entity.position) <= villagerRange)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))

  async function openNear(villager) {
    await goWithin(bot, new goals.GoalFollow(villager, 2), 30_000)
    return bot.openVillager(villager)
  }

  function listTrades() {
    startTask('looking at villager trades', async (task) => {
      const [villager] = villagersNearby()
      if (!villager) {
        say(`There's no villager within ${villagerRange} blocks.`)
        return
      }
      let window
      try {
        window = await openNear(villager)
      } catch (err) {
        if (!task.cancelled) say("I can't reach the villager.")
        return
      }
      const trades = window.trades ?? []
      window.close()
      log('INFO', `villager trades: ${trades.map(describeTrade).join('; ')}`)
      if (trades.length === 0) {
        say('This villager has nothing to trade (no job yet, or a nitwit).')
        return
      }
      const list = trades.slice(0, listedTrades).map((t, i) => `${i + 1}) ${describeTrade(t)}`).join(', ')
      const more = trades.length > listedTrades ? `, and ${trades.length - listedTrades} more` : ''
      say(`This villager offers: ${list}${more}.`)
    }, { log, onCancel: () => bot.pathfinder.setGoal(null), onEnd: resume })
  }

  function trade({ item, count }) {
    const wanted = Math.max(1, Math.min(count ?? 1, 64))
    startTask(`trading for ${pretty(item)}`, async (task) => {
      const villagers = villagersNearby()
      if (villagers.length === 0) {
        say(`There's no villager within ${villagerRange} blocks.`)
        return
      }
      // The cheapest offer seen that the bot couldn't afford, to say what's missing.
      let tooDear = null
      for (const villager of villagers) {
        if (task.cancelled) return
        let window
        try {
          window = await openNear(villager)
        } catch {
          continue
        }
        try {
          const index = window.trades.findIndex((t) => itemMatches(t.outputItem.name, item) && !t.tradeDisabled)
          if (index === -1) continue
          const offer = window.trades[index]
          const times = affordableTimes(offer, have, Math.ceil(wanted / offer.outputItem.count))
          if (times === 0) {
            tooDear ??= offer
            continue
          }
          await bot.trade(window, index, times)
          say(`Traded for ${times * offer.outputItem.count} ${pretty(offer.outputItem.name)} (${describeTrade(offer).split(' → ')[0]} each time).`)
          return
        } finally {
          window.close()
        }
      }
      if (task.cancelled) return
      if (tooDear) say(`A villager sells ${pretty(tooDear.outputItem.name)} for ${describeTrade(tooDear).split(' → ')[0]}, but I don't have enough.`)
      else say(`None of the villagers nearby sell ${pretty(item)}.`)
    }, { log, onCancel: () => bot.pathfinder.setGoal(null), onEnd: resume })
  }

  return { listTrades, trade }
}
