import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { blockSearches, nearbyBlocks } from '../core/state.js'
import { Vec3, registry } from './helpers.js'

const id = (name) => registry.blocksByName[name].id
const namesOf = (ids) => ids.map((i) => registry.blocks[i].name)

// A bot whose world is a list of { name, pos }. findBlocks answers like Mineflayer's: the nearest
// matching blocks first, at most `count`, within `maxDistance`.
function fakeBot(blocks) {
  const me = new Vec3(0, 64, 0)
  const searches = []
  return {
    searches,
    registry,
    entity: { position: me },
    findBlocks({ matching, maxDistance, count }) {
      searches.push(matching)
      const ids = [matching].flat()
      return blocks
        .filter((b) => ids.includes(id(b.name)) && b.pos.distanceTo(me) <= maxDistance)
        .sort((a, b) => a.pos.distanceTo(me) - b.pos.distanceTo(me))
        .slice(0, count)
        .map((b) => b.pos)
    },
    blockAt: (pos) => blocks.find((b) => b.pos.equals(pos)),
  }
}
const at = (name, x, z = 0, y = 64) => ({ name, pos: new Vec3(x, y, z) })

describe('block searches', () => {
  it('searches common blocks on their own and the rest in two groups, not one search per type', () => {
    const searches = blockSearches(registry).map(namesOf)
    assert.ok(searches.length <= 6, `${searches.length} searches`)
    for (const common of ['water', 'sand', 'gravel', 'clay']) assert.ok(searches.some((s) => s.length === 1 && s[0] === common))
    const logs = searches.find((s) => s.includes('oak_log'))
    assert.ok(logs.every((n) => n.endsWith('_log')) && logs.includes('mangrove_log'))
    const rest = searches.find((s) => s.includes('iron_ore'))
    for (const n of ['deepslate_diamond_ore', 'ancient_debris', 'crimson_stem', 'lava', 'chest', 'furnace', 'crafting_table', 'red_bed']) {
      assert.ok(rest.includes(n), n)
    }
    assert.ok(!rest.includes('water') && !rest.includes('oak_log'))
  })

  it('covers exactly the interesting blocks, each once', () => {
    const all = blockSearches(registry).flat()
    assert.equal(new Set(all).size, all.length)
    assert.ok(all.includes(id('water')) && all.includes(id('coal_ore')) && !all.includes(id('stone')) && !all.includes(id('dirt')))
  })
})

describe('nearbyBlocks', () => {
  it('reports each type once with its count and its nearest block, nearest type first', () => {
    const bot = fakeBot([at('oak_log', 5), at('oak_log', 3), at('oak_log', 8), at('iron_ore', 10, 10), at('water', 2), at('stone', 1)])
    const found = nearbyBlocks(bot)
    assert.deepEqual(found.map((g) => [g.name, g.count, g.more, g.distance]), [
      ['water', 1, false, 2],
      ['oak_log', 3, false, 3],
      ['iron_ore', 1, false, 14.1],
    ])
    assert.deepEqual(found[1].nearest, { x: 3, y: 64, z: 0 })
  })

  it('stops counting a type at 100 and says there are more', () => {
    const logs = Array.from({ length: 150 }, (_, i) => at('birch_log', 1 + (i % 30), Math.floor(i / 30), 64 + (i % 4)))
    const [group] = nearbyBlocks(fakeBot(logs))
    assert.equal(group.count, 100)
    assert.equal(group.more, true)
  })

  it('a crowded common block cannot hide a rare one', () => {
    const water = Array.from({ length: 2000 }, (_, i) => at('water', 1 + (i % 30), Math.floor(i / 30) % 20, 60 + (i % 3)))
    const found = nearbyBlocks(fakeBot([...water, at('diamond_ore', 15, 15, 58)]))
    assert.ok(found.some((g) => g.name === 'diamond_ore'))
    assert.equal(found.find((g) => g.name === 'water').count, 100)
  })

  it('ignores blocks beyond the scan radius and finds nothing in an empty world', () => {
    assert.deepEqual(nearbyBlocks(fakeBot([at('coal_ore', 40)])), [])
    assert.deepEqual(nearbyBlocks(fakeBot([])), [])
  })

  it('makes one search per group, however many block types exist', () => {
    const bot = fakeBot([at('oak_log', 3)])
    nearbyBlocks(bot)
    assert.equal(bot.searches.length, blockSearches(registry).length)
    assert.ok(bot.searches.length <= 6)
  })
})
