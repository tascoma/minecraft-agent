import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { chestPartner, itemMatches, keeps, sortPlan } from '../storage.js'
import { Vec3 } from './helpers.js'

describe('storage', () => {
  it('keeps tools, weapons, armor, torches and food when putting everything away', () => {
    const isFood = (n) => ['bread', 'cooked_beef'].includes(n)
    for (const name of ['iron_pickaxe', 'stone_sword', 'iron_chestplate', 'bow', 'arrow', 'shield', 'torch', 'bread']) {
      assert.equal(keeps(name, isFood), true, name)
    }
    for (const name of ['cobblestone', 'dirt', 'oak_log', 'raw_iron', 'rotten_flesh']) assert.equal(keeps(name, isFood), false, name)
  })

  it('matches items the way players name them', () => {
    assert.ok(itemMatches('iron_ingot', 'iron'))
    assert.ok(itemMatches('raw_iron', 'Iron'))
    assert.ok(itemMatches('oak_log', 'oak log'))
    assert.ok(!itemMatches('cobblestone', 'stone'))
  })

  it('finds the other half of a double chest', () => {
    const pos = new Vec3(0, 64, 0)
    assert.deepEqual(chestPartner(pos, { facing: 'north', type: 'left' }), new Vec3(1, 64, 0))
    assert.deepEqual(chestPartner(pos, { facing: 'north', type: 'right' }), new Vec3(-1, 64, 0))
    assert.deepEqual(chestPartner(pos, { facing: 'east', type: 'left' }), new Vec3(0, 64, 1))
    assert.equal(chestPartner(pos, { facing: 'north', type: 'single' }), null)
  })

  it('sends each item to the chest that already has the most of it', () => {
    const plan = sortPlan([
      { key: 'a', items: { cobblestone: 64, dirt: 5 } },
      { key: 'b', items: { cobblestone: 10, dirt: 30, iron_ingot: 2 } },
    ])
    assert.deepEqual(plan, { cobblestone: 'a', dirt: 'b', iron_ingot: 'b' })
  })
})
