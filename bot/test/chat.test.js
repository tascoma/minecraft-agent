import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createChatQueue } from '../core/chatQueue.js'
import { createChatterFilter } from '../core/chatter.js'

const player = (username, gamemode = 0) => ({ username, gamemode })
const bot = player('Claude')

describe('chatter filter', () => {
  const make = (clock = { t: 0 }) => ({ clock, filter: createChatterFilter({ botName: () => 'Claude', now: () => clock.t }) })

  it('answers everything when only one other player is around', () => {
    const { filter } = make()
    assert.equal(filter.shouldHandle('Steve', 'get wood', [bot, player('Steve')]), true)
  })

  it('ignores chat between players unless it names the bot', () => {
    const { filter } = make()
    const players = [bot, player('Steve'), player('Alex')]
    assert.equal(filter.shouldHandle('Steve', 'hey Alex, see that creeper?', players), false)
    assert.equal(filter.shouldHandle('Steve', 'claude, get wood', players), true)
    assert.equal(filter.shouldHandle('Steve', 'Claude', players), true)
  })

  it('keeps answering a player for a while after the bot spoke to them', () => {
    const { filter, clock } = make()
    const players = [bot, player('Steve'), player('Alex')]
    filter.spoke('Steve')
    clock.t = 29_000
    assert.equal(filter.shouldHandle('Steve', 'ok do it', players), true)
    assert.equal(filter.shouldHandle('Alex', 'ok do it', players), false, 'only the player it spoke to')
    clock.t = 31_000
    assert.equal(filter.shouldHandle('Steve', 'ok do it', players), false)
  })

  it('does not count spectators as someone to talk to', () => {
    const { filter } = make()
    assert.equal(filter.shouldHandle('ClaudeTester', 'follow me', [bot, player('Steve'), player('ClaudeTester', 3)]), true)
  })
})

describe('chat queue', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0))

  it('joins lines that arrive while a message is being answered', async () => {
    const handled = []
    let release
    const push = createChatQueue((sender, message) => {
      handled.push(message)
      return handled.length === 1 ? new Promise((r) => { release = r }) : Promise.resolve()
    })
    const done = push('Steve', 'one')
    push('Steve', 'two')
    push('Steve', 'three')
    await tick()
    assert.deepEqual(handled, ['one'], 'the first line is not delayed')
    release()
    await done
    assert.deepEqual(handled, ['one', 'two\nthree'])
  })

  it('keeps players separate, and recovers from a failed message', async () => {
    const handled = []
    const push = createChatQueue(async (sender, message) => {
      handled.push(`${sender}:${message}`)
      if (message === 'boom') throw new Error('boom')
    })
    await Promise.all([push('Steve', 'boom'), push('Alex', 'hi')])
    await push('Steve', 'again')
    assert.deepEqual(handled.sort(), ['Alex:hi', 'Steve:again', 'Steve:boom'])
  })
})
