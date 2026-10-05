import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { portalLayout } from '../building.js'
import { oreLevels, resolveTarget } from '../gathering.js'
import { affordableTimes, describeTrade } from '../trading.js'
import { bearing, readEye } from '../travel.js'
import { registry, Vec3 } from './helpers.js'

describe('progression', () => {
  it('reads which way a thrown eye of ender flew', () => {
    assert.deepEqual(bearing(0, -5), { degrees: 0, point: 'north' })
    assert.deepEqual(bearing(5, 0), { degrees: 90, point: 'east' })
    assert.equal(bearing(3, 3).point, 'south-east')
    assert.equal(readEye([new Vec3(0, 70, 0), new Vec3(4, 72, -4)]).point, 'north-east')
    assert.deepEqual(readEye([new Vec3(0, 70, 0), new Vec3(0.5, 66, 0.3)]), { went: 'down' })
  })

  it('lays out a portal: 10 obsidian, 4 corners, 6 open inside', () => {
    const cells = portalLayout(new Vec3(0, 64, 0), 'x')
    const count = (part) => cells.filter((c) => c.part === part).length
    assert.deepEqual([count('frame'), count('corner'), count('inside')], [10, 4, 6])
    assert.ok(cells.every((c) => c.pos.z === 0), 'flat along x')
    assert.ok(portalLayout(new Vec3(0, 64, 0), 'z').every((c) => c.pos.x === 0), 'or along z')
  })

  it('prices villager trades and works out how many it can afford', () => {
    const offer = {
      inputItem1: { name: 'emerald', count: 3 }, realPrice: 2, outputItem: { name: 'bread', count: 6 },
      hasItem2: false, inputItem2: null, tradeDisabled: false, nbTradeUses: 10, maximumNbTradeUses: 12,
    }
    assert.equal(describeTrade(offer), '2 emerald → 6 bread')
    const have = (n) => ({ emerald: 9 })[n] ?? 0
    assert.equal(affordableTimes(offer, have, 10), 2, 'only 2 uses left before it sells out')
    assert.equal(affordableTimes({ ...offer, nbTradeUses: 0 }, have, 10), 4, '9 emeralds at 2 each')
    assert.equal(affordableTimes({ ...offer, tradeDisabled: true }, have, 10), 0)
  })

  it('knows where to dig for ores, and that gravel gives flint', () => {
    const level = (item) => [...resolveTarget(registry, item).items].map((i) => oreLevels[i]).find((y) => y != null)
    assert.equal(level('diamond'), -58)
    assert.equal(level('iron_ore'), 16)
    const flint = resolveTarget(registry, 'flint')
    assert.deepEqual([...flint.items], ['flint'])
    assert.ok(flint.blockIds.includes(registry.blocksByName.gravel.id))
    assert.ok(resolveTarget(registry, 'wheat_seeds').blockIds.includes(registry.blocksByName.short_grass.id))
  })
})
