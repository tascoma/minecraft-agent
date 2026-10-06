import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { attackCooldownMs, bestWeapon, canAttack, findTarget, isAggressive } from '../reflexes/combat.js'
import { Vec3 } from './helpers.js'

const mob = (name, type, x = 0) => ({ name, type, position: new Vec3(x, 64, 0) })
const me = new Vec3(0, 64, 0)

describe('combat', () => {
  it('never hits players, villagers, golems, pets or things that are not creatures', () => {
    assert.equal(canAttack({ name: 'player', type: 'player', username: 'Steve' }), false)
    for (const [name, type] of [['villager', 'passive'], ['iron_golem', 'mob'], ['wolf', 'animal'], ['cat', 'animal'],
      ['horse', 'animal'], ['item', 'other'], ['boat', 'other'], ['armor_stand', 'living'], ['arrow', 'projectile'], ['warden', 'hostile']]) {
      assert.equal(canAttack(mob(name, type)), false, name)
    }
    assert.equal(canAttack(mob('zombie', 'hostile')), true)
    assert.equal(canAttack(mob('cow', 'animal')), true)
  })

  it('treats only mobs that attack on sight as threats', () => {
    assert.equal(isAggressive(mob('zombie', 'hostile')), true)
    assert.equal(isAggressive(mob('phantom', 'mob')), true)
    assert.equal(isAggressive(mob('creeper', 'hostile')), false, 'creepers are avoided, not fought')
    assert.equal(isAggressive(mob('enderman', 'hostile')), false, 'neutral until provoked')
    assert.equal(isAggressive(mob('cow', 'animal')), false)
  })

  it('picks the strongest weapon, preferring a sword at the same tier', () => {
    const items = [{ name: 'iron_axe' }, { name: 'stone_sword' }, { name: 'iron_sword' }, { name: 'bread' }]
    assert.equal(bestWeapon(items).name, 'iron_sword')
    assert.equal(bestWeapon([{ name: 'bread' }]), null)
    assert.ok(attackCooldownMs('iron_axe') > attackCooldownMs('iron_sword'))
  })

  it('finds what the player means, nearest first, and never a protected mob', () => {
    const entities = [mob('zombie', 'hostile', 10), mob('zombie', 'hostile', 4), mob('cow', 'animal', 2), mob('villager', 'passive', 1)]
    assert.equal(findTarget(entities, me, 'that zombie').position.x, 4)
    assert.equal(findTarget(entities, me, 'Zombies').position.x, 4)
    assert.equal(findTarget(entities, me, 'cow').name, 'cow')
    assert.equal(findTarget(entities, me, null).position.x, 4, 'no name means the nearest hostile')
    assert.equal(findTarget(entities, me, 'villager'), null)
    assert.equal(findTarget([mob('zombie', 'hostile', 40)], me, 'zombie'), null, 'too far away')
  })
})
