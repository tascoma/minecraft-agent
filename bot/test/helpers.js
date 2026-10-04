// Stand-ins for a Mineflayer bot, enough for movement rules and target lookups. No server needed.
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
export const registry = require('minecraft-data')('1.21.1')
const Block = require('prismarine-block')(registry)
const { Vec3 } = require('vec3')

export { Vec3 }

// A block of `name` in the first state whose properties match `props`, e.g. { open: true }.
export function blockState(name, props = {}) {
  const block = registry.blocksByName[name]
  for (let id = block.minStateId; id <= block.maxStateId; id++) {
    const properties = Block.fromStateId(id, 0).getProperties()
    if (Object.entries(props).every(([k, v]) => properties[k] === v)) return id
  }
  throw new Error(`no ${name} state matching ${JSON.stringify(props)}`)
}

// A bot whose whole world is made of one block state, which tests can change.
export function fakeBot() {
  const bot = {
    registry,
    version: '1.21.1',
    game: { dimension: 'overworld' },
    inventory: { items: () => [] },
    stateId: blockState('stone'),
    blockAt(pos) {
      const block = Block.fromStateId(bot.stateId, 0)
      block.position = pos
      return block
    },
  }
  return bot
}
