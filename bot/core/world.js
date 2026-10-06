// Works out which world the bot is in, so the backend keeps places and memories per world.

// Set MC_WORLD to name a world yourself; otherwise the id is the world's hashed seed, which stays
// the same when you reopen the world on a different LAN port.
let worldId = null

export const currentWorldId = () => worldId

// The login packet carries the seed hash: at the top level before 1.20.2, inside worldState after.
// Depending on the protocol version it is a BigInt, a number or a [high, low] pair.
export function seedHash(packet) {
  const seed = packet.hashedSeed ?? packet.worldState?.hashedSeed
  if (seed === undefined || seed === null) return null
  const value = Array.isArray(seed)
    ? (BigInt(seed[0]) << 32n) | BigInt(seed[1] >>> 0)
    : BigInt(seed)
  return BigInt.asUintN(64, value).toString(16)
}

export function setWorldFromLogin(packet, { override, host, port }) {
  const hash = seedHash(packet)
  worldId = override || (hash ? `seed-${hash}` : `${host}:${port}`)
  return worldId
}
