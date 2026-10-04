import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'
import { chooseVariant, fuelValue, keyFor, requirements, smelting } from '../crafting.js'
import { registry } from './helpers.js'

const require = createRequire(import.meta.url)
const { Recipe } = require('prismarine-recipe')(registry)
const recipes = (name) => Recipe.find(registry.itemsByName[name].id, null)
const ingredients = (recipe) => recipe.delta.filter((d) => d.count < 0).map((d) => registry.items[d.id].name).sort()

// Inventory as {item: count}; families are counted together, like the bot does.
function counter(inventory) {
  return (key) => Object.entries(inventory)
    .filter(([name]) => keyFor(name) === key || name === key)
    .reduce((n, [, c]) => n + c, 0)
}

describe('keyFor', () => {
  it('groups interchangeable ingredients', () => {
    assert.equal(keyFor('birch_planks'), 'family:planks')
    assert.equal(keyFor('oak_log'), 'family:log')
    assert.equal(keyFor('cobbled_deepslate'), 'family:cobble')
    assert.equal(keyFor('charcoal'), 'family:coal')
    assert.equal(keyFor('stripped_oak_log'), 'stripped_oak_log')
    assert.equal(keyFor('stick'), 'stick')
  })
})

describe('requirements', () => {
  it('scales a recipe and uses family keys', () => {
    const pickaxe = recipes('wooden_pickaxe')[0]
    assert.deepEqual(Object.fromEntries(requirements(pickaxe, 2, registry)), { 'family:planks': 6, stick: 4 })
  })
})

describe('chooseVariant', () => {
  it('plans sticks from planks, not bamboo, when it has nothing', () => {
    const plan = chooseVariant(recipes('stick'), registry, counter({}))
    assert.ok(ingredients(plan).every((n) => n.endsWith('_planks')), ingredients(plan).join())
  })

  it('prefers what the bot holds', () => {
    const plan = chooseVariant(recipes('stick'), registry, counter({ bamboo: 4 }))
    assert.deepEqual(ingredients(plan), ['bamboo'])
  })

  it('plans a stone pickaxe from any cobblestone-like block', () => {
    const plan = chooseVariant(recipes('stone_pickaxe'), registry, counter({ cobblestone: 3, stick: 2 }))
    assert.deepEqual(Object.fromEntries(requirements(plan, 1, registry)), { 'family:cobble': 3, stick: 2 })
  })
})

describe('smelting and fuel', () => {
  it('knows common furnace recipes', () => {
    assert.equal(smelting.iron_ingot, 'raw_iron')
    assert.equal(smelting.glass, 'sand')
    assert.equal(smelting.charcoal, 'family:log')
    assert.equal(smelting.cooked_beef, 'beef')
  })

  it('values fuel by how many items it smelts', () => {
    assert.equal(fuelValue('coal'), 8)
    assert.equal(fuelValue('birch_planks'), 1.5)
    assert.equal(fuelValue('oak_log'), 1.5)
    assert.equal(fuelValue('cobblestone'), 0)
  })
})

describe('plural', () => {
  it('pluralizes countable items and leaves mass nouns alone', async () => {
    const { plural } = await import('../crafting.js')
    assert.equal(plural(4, 'torch'), '4 torches')
    assert.equal(plural(2, 'stone_pickaxe'), '2 stone pickaxes')
    assert.equal(plural(1, 'stone_pickaxe'), '1 stone pickaxe')
    assert.equal(plural(8, 'cobblestone'), '8 cobblestone')
    assert.equal(plural(3, 'iron_ingot'), '3 iron ingots')
    assert.equal(plural(2, 'glass'), '2 glass')
  })
})
