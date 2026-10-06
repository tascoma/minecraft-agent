// The physics patch (patches/prismarine-physics+*.patch): stepping up from a slightly lower block
// (a dirt path, 15/16 high) into a doorway with a wall block just above it.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'
import { registry, Vec3 } from './helpers.js'

const require = createRequire(import.meta.url)
const { Physics, PlayerState } = require('prismarine-physics')
const Block = require('prismarine-block')(registry)

// x <= 0: a dirt path to stand on. x >= 1: a cobblestone floor, and a cobblestone wall above head
// height (y 2) like the wall over a door. Air everywhere else.
function doorway(pos) {
  const p = pos.floored()
  const name = p.y === -1 ? (p.x <= 0 ? 'dirt_path' : 'cobblestone') : p.y === 2 && p.x >= 1 ? 'cobblestone' : 'air'
  const block = Block.fromStateId(registry.blocksByName[name].defaultState, 0)
  block.position = p
  return block
}

function walker(x) {
  return {
    version: '1.21.1',
    entity: {
      position: new Vec3(x, -0.0625, 0.5), velocity: new Vec3(0, 0, 0), onGround: true,
      isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: false,
      elytraFlying: false, attributes: {}, yaw: -Math.PI / 2, pitch: 0, effects: {},
    },
    jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, inventory: { slots: [] },
  }
}

describe('physics', () => {
  it('steps up from a dirt path into a doorway with a wall just above it', () => {
    const physics = Physics(registry, { getBlock: doorway })
    const state = new PlayerState(walker(0.5), { forward: true, back: false, left: false, right: false, jump: false, sprint: false, sneak: false })
    for (let tick = 0; tick < 20; tick++) physics.simulatePlayer(state, { getBlock: doorway })
    assert.ok(state.pos.x > 1.5, `walked into the doorway (x ${state.pos.x.toFixed(2)})`)
    assert.equal(state.pos.y, 0, 'standing on the cobblestone floor')
  })
})
