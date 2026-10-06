import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { aimPitch, aimPoint, arrowDrop, distanceToSegment, someoneInTheWay } from '../reflexes/archery.js'
import { mustNotHit } from '../reflexes/combat.js'
import { Vec3 } from './helpers.js'

describe('archery', () => {
  it('aims a little up at distance, so the arrow drops onto the target', () => {
    for (const [distance, rise] of [[8, 0], [20, 0], [20, -5], [15, 6]]) {
      const { pitch } = aimPitch(distance, rise)
      assert.ok(Math.abs(arrowDrop(pitch, distance).dy - rise) < 0.05, `${distance} blocks, rise ${rise}`)
    }
    assert.ok(aimPitch(20, 0).pitch > aimPitch(8, 0).pitch, 'farther needs a higher aim')
    assert.equal(aimPitch(20, 200), null, 'out of reach')
  })

  it('leads a moving target', () => {
    const eye = new Vec3(0, 65.6, 0)
    const target = new Vec3(20, 65, 0)
    const still = aimPoint(eye, target)
    const moving = aimPoint(eye, target, new Vec3(0, 0, 0.2))
    assert.ok(Math.abs(still.z) < 1e-9)
    assert.ok(moving.z > 1, 'aims ahead of where it is walking')
  })

  it('holds fire when a player or villager is near the line of fire or just behind the target', () => {
    const eye = new Vec3(0, 65.6, 0)
    const target = new Vec3(20, 65, 0)
    const at = (x, z, type, name) => ({ type, name, position: new Vec3(x, 64, z), height: 1.8 })
    assert.equal(distanceToSegment(new Vec3(5, 0, 3), new Vec3(0, 0, 0), new Vec3(10, 0, 0)), 3)
    assert.equal(someoneInTheWay(eye, target, [at(10, 0.5, 'player', 'player')], mustNotHit), true)
    assert.equal(someoneInTheWay(eye, target, [at(22, 0, 'passive', 'villager')], mustNotHit), true, 'behind the target')
    assert.equal(someoneInTheWay(eye, target, [at(10, 8, 'player', 'player')], mustNotHit), false, 'well off to the side')
    assert.equal(someoneInTheWay(eye, target, [at(10, 0, 'hostile', 'zombie')], mustNotHit), false, 'a zombie in the way is fine')
  })
})
