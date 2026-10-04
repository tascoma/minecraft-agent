import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { CompanionMovements, isManMade, isProtected, protectedRadius, setProtectedSpots } from '../movements.js'
import { Vec3, blockState, fakeBot } from './helpers.js'

describe('isManMade', () => {
  it('flags blocks players build with', () => {
    for (const name of ['oak_planks', 'cobblestone', 'glass', 'oak_door', 'chest', 'red_bed', 'stone_bricks', 'farmland', 'wheat', 'torch']) {
      assert.ok(isManMade(name), name)
    }
  })
  it('leaves natural blocks alone', () => {
    for (const name of ['stone', 'dirt', 'grass_block', 'oak_log', 'sand', 'gravel', 'coal_ore', 'deepslate', 'oak_leaves']) {
      assert.ok(!isManMade(name), name)
    }
  })
})

describe('isProtected', () => {
  afterEach(() => setProtectedSpots([]))

  it('protects a horizontal radius around saved places in the same dimension', () => {
    setProtectedSpots([{ x: 0, y: 64, z: 0, dimension: 'overworld' }])
    assert.ok(isProtected({ x: protectedRadius, y: 10, z: 0 }, 'overworld'), 'edge of the zone, any height')
    assert.ok(!isProtected({ x: protectedRadius + 1, y: 64, z: 0 }, 'overworld'))
    assert.ok(!isProtected({ x: 0, y: 64, z: 0 }, 'the_nether'), 'other dimension')
  })

  it('protects nothing before saved places are loaded', () => {
    assert.ok(!isProtected({ x: 0, y: 64, z: 0 }, 'overworld'))
  })
})

describe('CompanionMovements', () => {
  const at = (m) => m.getBlock(new Vec3(0, 64, 0), 0, 0, 0)

  it('walks through open doors and gates, and opens closed wooden ones', () => {
    const bot = fakeBot()
    const m = new CompanionMovements(bot)
    const cases = [
      ['oak_door', { open: false, half: 'lower' }, { safe: false, openable: true }],
      ['oak_door', { open: false, half: 'upper' }, { safe: true, openable: false }],
      ['oak_door', { open: true, half: 'lower' }, { safe: true, openable: false }],
      ['oak_fence_gate', { open: false }, { safe: false, openable: true }],
      ['oak_fence_gate', { open: true }, { safe: true, openable: false }],
      ['iron_door', { open: false, half: 'lower' }, { safe: false, openable: false }],
    ]
    for (const [name, props, expected] of cases) {
      bot.stateId = blockState(name, props)
      const b = at(m)
      assert.deepEqual({ safe: b.safe, openable: b.openable }, expected, `${name} ${JSON.stringify(props)}`)
    }
  })

  it('never breaks man-made blocks', () => {
    const bot = fakeBot()
    const m = new CompanionMovements(bot, { gather: true })
    bot.stateId = blockState('oak_planks')
    assert.ok(!m.safeToBreak(at(m)))
    bot.stateId = blockState('stone')
    assert.ok(m.safeToBreak(at(m)))
  })

  it('never breaks blocks near saved places', () => {
    const bot = fakeBot()
    const m = new CompanionMovements(bot, { gather: true })
    setProtectedSpots([{ x: 0, y: 64, z: 0, dimension: 'overworld' }])
    try {
      assert.ok(!m.safeToBreak(at(m)))
    } finally {
      setProtectedSpots([])
    }
  })

  it('digs and builds only as a last resort while walking', () => {
    const bot = fakeBot()
    const walking = new CompanionMovements(bot)
    const gathering = new CompanionMovements(bot, { gather: true })
    assert.ok(walking.digCost > gathering.digCost)
    assert.ok(walking.placeCost > gathering.placeCost)
    assert.ok(walking.canDig, 'can still dig out of a hole')
    assert.equal(walking.maxDropDown, 3)
  })
})
