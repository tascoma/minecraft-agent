import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { nearlyBroken, resolveTarget } from '../jobs/gathering.js'
import { registry } from './helpers.js'

const names = (target) => target.blockIds.map((id) => registry.blocks[id].name).sort()

describe('resolveTarget', () => {
  it('mines stone for cobblestone', () => {
    const t = resolveTarget(registry, 'cobblestone')
    assert.deepEqual(names(t), ['stone'])
    assert.deepEqual([...t.items], ['cobblestone'])
    assert.equal(resolveTarget(registry, 'stone').label, 'cobblestone')
  })

  it('digs every natural block that drops the item', () => {
    assert.ok(names(resolveTarget(registry, 'dirt')).includes('grass_block'))
    assert.deepEqual(names(resolveTarget(registry, 'coal')), ['coal_ore', 'deepslate_coal_ore'])
  })

  it('handles ore names, item names, spaces and the minecraft: prefix', () => {
    for (const name of ['iron_ore', 'raw_iron', 'Raw Iron', 'minecraft:iron_ore']) {
      const t = resolveTarget(registry, name)
      assert.deepEqual(names(t), ['deepslate_iron_ore', 'iron_ore'], name)
      assert.equal(t.label, 'raw iron', name)
    }
  })

  it('treats "logs" as any kind of tree', () => {
    const t = resolveTarget(registry, 'logs')
    assert.equal(t.label, 'logs')
    assert.ok(names(t).includes('oak_log') && names(t).includes('birch_log'))
    assert.ok(!names(t).some((n) => n.startsWith('stripped_')))
  })

  it('refuses crafted and unknown things', () => {
    assert.equal(resolveTarget(registry, 'oak_planks'), null)
    assert.equal(resolveTarget(registry, 'chest'), null)
    assert.equal(resolveTarget(registry, 'banana'), null)
  })
})

describe('worn tools', () => {
  it('knows when a tool is about to break', () => {
    assert.equal(nearlyBroken({ maxDurability: 131, durabilityUsed: 125 }), true, '6 uses left of 131: under 5%')
    assert.equal(nearlyBroken({ maxDurability: 131, durabilityUsed: 100 }), false)
    assert.equal(nearlyBroken({ maxDurability: 59, durabilityUsed: 56 }), true, 'wood: 3 uses left')
    assert.equal(nearlyBroken({ name: 'dirt' }), false, 'not a tool')
  })
})
