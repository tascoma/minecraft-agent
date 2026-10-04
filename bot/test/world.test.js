import assert from 'node:assert/strict'
import { test } from 'node:test'
import { seedHash, setWorldFromLogin, currentWorldId } from '../world.js'

const where = { host: 'localhost', port: 25565 }

test('reads the seed hash from either login packet layout', () => {
  assert.equal(seedHash({ hashedSeed: [0, 255] }), 'ff')
  assert.equal(seedHash({ worldState: { hashedSeed: 255n } }), 'ff')
  assert.equal(seedHash({ hashedSeed: [-1, -1] }), 'ffffffffffffffff')
  assert.equal(seedHash({}), null)
})

test('world id is the override, else the seed, else the address', () => {
  assert.equal(setWorldFromLogin({ hashedSeed: [0, 255] }, { ...where }), 'seed-ff')
  assert.equal(setWorldFromLogin({ hashedSeed: [0, 255] }, { ...where, override: 'survival' }), 'survival')
  assert.equal(setWorldFromLogin({}, { ...where }), 'localhost:25565')
  assert.equal(currentWorldId(), 'localhost:25565')
})
