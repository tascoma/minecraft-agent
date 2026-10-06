import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { compass, facingFromYaw, layout, nextToPlace, pickMaterial, torchSpots } from '../jobs/building.js'
import { Vec3 } from './helpers.js'

const origin = new Vec3(0, 64, 0)
const key = (p) => `${p.x},${p.y},${p.z}`

describe('building', () => {
  it('lays out a shelter: 5x5 walls 2 high with a door gap, and a roof', () => {
    const parts = layout('shelter', origin, 'south')
    const walls = parts.filter((p) => p.part === 'wall')
    const roof = parts.filter((p) => p.part === 'roof')
    const door = parts.filter((p) => p.part === 'door')
    assert.equal(roof.length, 25)
    assert.equal(walls.length, 16 * 2 - 2, 'perimeter of 16, two high, minus the doorway')
    assert.deepEqual(door.map((d) => key(d.pos)), ['0,64,2'])
    assert.ok(!walls.some((w) => w.pos.x === 0 && w.pos.z === 2 && w.pos.y <= 65), 'doorway left open')
    assert.ok(roof.every((r) => r.pos.y === 66))
    assert.ok(!parts.some((p) => Math.abs(p.pos.x) < 2 && Math.abs(p.pos.z) < 2 && p.pos.y < 66), 'inside stays empty')
  })

  it('makes a hut bigger, with the door on the side asked for', () => {
    const parts = layout('hut', origin, 'east')
    assert.equal(parts.filter((p) => p.part === 'roof').length, 49)
    assert.deepEqual(parts.filter((p) => p.part === 'door').map((d) => key(d.pos)), ['3,64,0'])
  })

  it('builds bottom-up, only against something solid', () => {
    const solid = new Set(['0,63,0', '1,63,0'])
    const isSolid = (p) => solid.has(key(p))
    const remaining = [new Vec3(5, 70, 5), new Vec3(1, 65, 0), new Vec3(1, 64, 0), new Vec3(0, 64, 0)]
    const i = nextToPlace(remaining, isSolid, new Vec3(0, 64, 0))
    assert.equal(key(remaining[i]), '0,64,0', 'lowest, supported, nearest')
    assert.equal(nextToPlace([new Vec3(5, 70, 5)], isSolid, origin), -1, 'floating blocks wait')
  })

  it('spaces torches out and keeps away from existing light', () => {
    const candidates = [0, 2, 4, 8, 12, 16].map((x) => new Vec3(x, 64, 0))
    const spots = torchSpots(candidates, [new Vec3(16, 64, 0)])
    assert.deepEqual(spots.map((p) => p.x), [0, 8])
  })

  it('picks the material it has most of, if that is enough', () => {
    const counts = { cobblestone: 40, 'family:planks': 12, dirt: 64 }
    assert.equal(pickMaterial((m) => counts[m] ?? 0, 30), 'dirt')
    assert.equal(pickMaterial((m) => counts[m] ?? 0, 100), null)
  })

  it('turns directions and yaw into compass points', () => {
    assert.equal(compass(new Vec3(3, 0, 1)), 'east')
    assert.equal(compass(new Vec3(0, 0, -2)), 'north')
    assert.equal(facingFromYaw(0), 'north')
    assert.equal(facingFromYaw(Math.PI / 2), 'west')
    assert.equal(facingFromYaw(Math.PI), 'south')
  })
})
