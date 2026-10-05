import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'
import { animalName, animalsFor, cropName, isBaby, isRipe, isSheared } from '../farming.js'
import { registry } from './helpers.js'

const Block = createRequire(import.meta.url)('prismarine-block')(registry)

// A crop block at a given age.
function crop(name, age) {
  const block = registry.blocksByName[name]
  for (let id = block.minStateId; id <= block.maxStateId; id++) {
    const b = Block.fromStateId(id, 0)
    if (Number(b.getProperties().age) === age) return b
  }
  throw new Error(`no ${name} at age ${age}`)
}

describe('farming', () => {
  it('understands animals the way players name them', () => {
    assert.equal(animalName('Cows'), 'cow')
    assert.equal(animalName('the chickens'), 'chicken')
    assert.equal(animalName('sheep'), 'sheep')
    assert.equal(animalName('pig'), 'pig')
  })

  it('understands crops by crop, item or seed name', () => {
    assert.equal(cropName('wheat'), 'wheat')
    assert.equal(cropName('carrot'), 'carrots')
    assert.equal(cropName('potatoes'), 'potatoes')
    assert.equal(cropName('beetroot seeds'), 'beetroots')
    assert.equal(cropName('cactus'), null)
  })

  it('knows when crops are ripe (beetroots ripen at 3, the rest at 7)', () => {
    assert.equal(isRipe(crop('wheat', 7)), true)
    assert.equal(isRipe(crop('wheat', 6)), false)
    assert.equal(isRipe(crop('beetroots', 3)), true)
    assert.equal(isRipe(registry.blocksByName.stone && Block.fromStateId(registry.blocksByName.stone.defaultState, 0)), false)
  })

  it('knows which animals drop what, for hunting', () => {
    assert.deepEqual(animalsFor('beef'), ['cow', 'mooshroom'])
    assert.deepEqual(animalsFor('mutton'), ['sheep'])
    assert.equal(animalsFor('cobblestone'), null)
  })

  it('reads babies and sheared sheep from entity metadata', () => {
    assert.equal(isBaby({ metadata: { 16: true } }), true)
    assert.equal(isBaby({ metadata: {} }), false)
    assert.equal(isSheared({ metadata: { 17: 0x10 | 3 } }), true)
    assert.equal(isSheared({ metadata: { 17: 3 } }), false)
  })
})
