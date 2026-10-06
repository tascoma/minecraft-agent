// Bow maths: where to aim so an arrow lands on a target, and whether a shot could hit someone
// it mustn't. Pure functions, so they can be tested without a server.
import { Vec3 } from 'vec3'

// A fully drawn arrow leaves at 3 blocks per tick; each tick it moves, then slows by 1% and falls.
const arrowSpeed = 3
const drag = 0.99
const gravity = 0.05
const maxTicks = 100

/**
 * Where an arrow shot at `pitch` (radians, up is positive) is after travelling `distance` blocks
 * horizontally: { dy, ticks }, or null if it never gets that far.
 */
export function arrowDrop(pitch, distance) {
  let vx = Math.cos(pitch) * arrowSpeed
  let vy = Math.sin(pitch) * arrowSpeed
  let x = 0
  let y = 0
  for (let tick = 1; tick <= maxTicks; tick++) {
    const nx = x + vx
    const ny = y + vy
    if (nx >= distance) {
      // Between two ticks the arrow flies in a straight line.
      const part = (distance - x) / (nx - x)
      return { dy: y + (ny - y) * part, ticks: tick - 1 + part }
    }
    x = nx
    y = ny
    vx *= drag
    vy = vy * drag - gravity
  }
  return null
}

/**
 * The pitch that lands an arrow `rise` blocks higher (negative: lower) after `distance` blocks
 * horizontally, on the flat (direct) arc, with its flight time in ticks; null if out of range.
 */
export function aimPitch(distance, rise) {
  let low = -Math.PI / 4
  let high = Math.PI / 4
  if ((arrowDrop(high, distance)?.dy ?? -Infinity) < rise) return null
  // Higher pitch, higher arrow (on the flat arc), so a binary search finds it.
  for (let i = 0; i < 40; i++) {
    const mid = (low + high) / 2
    const hit = arrowDrop(mid, distance)
    if (hit && hit.dy >= rise) high = mid
    else low = mid
  }
  const hit = arrowDrop(high, distance)
  return hit && { pitch: high, ticks: hit.ticks }
}

/**
 * The point to look at to hit `target` (a position, e.g. a mob's chest) from `eye`, leading it by
 * `velocity` blocks per tick. Null when it's out of range.
 */
export function aimPoint(eye, target, velocity = new Vec3(0, 0, 0)) {
  let aimAt = target
  let pitch = null
  // Lead the target by where it will be when the arrow arrives; twice is close enough.
  for (let i = 0; i < 2; i++) {
    const dx = aimAt.x - eye.x
    const dz = aimAt.z - eye.z
    const distance = Math.hypot(dx, dz)
    pitch = aimPitch(distance, aimAt.y - eye.y)
    if (!pitch) return null
    aimAt = target.plus(velocity.scaled(pitch.ticks))
  }
  const dx = aimAt.x - eye.x
  const dz = aimAt.z - eye.z
  const distance = Math.hypot(dx, dz)
  return new Vec3(aimAt.x, eye.y + distance * Math.tan(pitch.pitch), aimAt.z)
}

/** How far `point` is from the line segment from `a` to `b`. */
export function distanceToSegment(point, a, b) {
  const ab = b.minus(a)
  const length = ab.dot(ab)
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, point.minus(a).dot(ab) / length))
  return point.distanceTo(a.plus(ab.scaled(t)))
}

/**
 * True when someone who mustn't be hit (`isProtected(entity)`) is near the line of fire from `eye`
 * to `target`, or close behind the target where a miss would land.
 */
export function someoneInTheWay(eye, target, entities, isProtected) {
  const beyond = target.plus(target.minus(eye).normalize().scaled(4))
  return entities.some((e) => {
    if (!isProtected(e)) return false
    const body = e.position.offset(0, (e.height ?? 1.8) / 2, 0)
    return distanceToSegment(body, eye, beyond) < 2
  })
}
