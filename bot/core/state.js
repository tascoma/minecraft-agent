// Builds the snapshot of the bot's situation that is sent to the backend with every chat.
import { currentFight } from '../reflexes/combat.js'
import { lastDeathInfo } from '../reflexes/survival.js'
import { measure } from './perf.js'
import { currentTask } from './tasks.js'
import { currentWorldId } from './world.js'

// How far the bot looks for blocks and entities, in blocks.
const scanRadius = 32

// Block names worth telling the agent about. Everything else (stone, dirt, grass) is noise.
const interestingBlock = (name) =>
  name.endsWith('_ore') ||
  name === 'ancient_debris' ||
  name.endsWith('_log') ||
  name.endsWith('_stem') ||
  ['water', 'lava', 'crafting_table', 'furnace', 'chest', 'barrel', 'bed', 'sand', 'gravel', 'clay'].includes(name) ||
  name.endsWith('_bed')

const round1 = (n) => Math.round(n * 10) / 10
const point = (v) => ({ x: Math.floor(v.x), y: Math.floor(v.y), z: Math.floor(v.z) })

// Most blocks of one type the bot counts. Common blocks (water, sand) are searched on their own,
// so they can't use up a shared search and hide rarer ones (logs, ores).
const maxPerType = 100
// Most blocks one grouped search returns, nearest first, before it stops. It only matters when a
// group is very crowded (a dense forest, a cave full of ore); then the farthest types drop out.
const maxPerSearch = 1500

// Blocks that are common enough to crowd out others, so each gets a search of its own. Everything
// else interesting is searched in two groups (logs, and the rest) rather than once per block type:
// each search walks the whole area, so ~130 searches took over a second on every chat.
const crowdsOthers = ['water', 'sand', 'gravel', 'clay']

/** The groups of block ids to search for: one array per search. */
export function blockSearches(registry) {
  const own = new Map(crowdsOthers.map((name) => [name, []]))
  const logs = []
  const rest = []
  for (const block of registry.blocksArray) {
    if (!interestingBlock(block.name)) continue
    if (own.has(block.name)) own.get(block.name).push(block.id)
    else if (block.name.endsWith('_log')) logs.push(block.id)
    else rest.push(block.id)
  }
  return [...own.values(), logs, rest].filter((ids) => ids.length > 0)
}

const searchesFor = new WeakMap() // registry -> its block searches

export function nearbyBlocks(bot) {
  const me = bot.entity.position
  const types = new Map() // name -> { count, nearest }
  if (!searchesFor.has(bot.registry)) searchesFor.set(bot.registry, blockSearches(bot.registry))
  for (const ids of searchesFor.get(bot.registry)) {
    // findBlocks returns the nearest first, so the first block of a type is its nearest.
    for (const pos of bot.findBlocks({ matching: ids, maxDistance: scanRadius, count: maxPerSearch })) {
      const name = bot.blockAt(pos)?.name
      if (!name) continue
      const seen = types.get(name)
      if (!seen) types.set(name, { count: 1, nearest: pos })
      else if (seen.count < maxPerType) seen.count++
    }
  }
  const groups = [...types].map(([name, { count, nearest }]) => ({
    name,
    count,
    // The count stopped at its cap, so there are probably more.
    more: count === maxPerType,
    nearest: point(nearest),
    distance: round1(me.distanceTo(nearest)),
  }))
  return groups.sort((a, b) => a.distance - b.distance)
}
function nearbyEntities(bot) {
  const me = bot.entity.position
  return Object.values(bot.entities)
    .filter((e) => e !== bot.entity && e.position.distanceTo(me) <= scanRadius)
    .map((e) => {
      const entity = {
        name: e.type === 'player' ? e.username : e.name,
        kind: e.type,
        distance: round1(e.position.distanceTo(me)),
        position: point(e.position),
      }
      const dropped = e.getDroppedItem?.()
      if (dropped) Object.assign(entity, { kind: 'item', name: dropped.name, count: dropped.count })
      return entity
    })
    .filter((e) => e.kind !== 'projectile' && e.name)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 30)
}

// Where the bot died, while its dropped items are still there to pick up; otherwise null.
function deathSnapshot() {
  const death = lastDeathInfo()
  if (!death) return null
  return { position: point(death.position), dimension: death.dimension, seconds_ago: death.secondsAgo }
}

export function snapshot(bot, speaker, { following = null } = {}) {
  const me = bot.entity.position
  const speakerEntity = bot.players[speaker]?.entity
  return {
    health: round1(bot.health),
    food: bot.food,
    position: point(me),
    dimension: bot.game.dimension,
    world_id: currentWorldId(),
    time_of_day: bot.time.timeOfDay,
    raining: bot.isRaining,
    thundering: bot.thunderState > 0,
    held_item: bot.heldItem?.name ?? null,
    inventory: bot.inventory.items().map((i) => ({ name: i.name, count: i.count })),
    nearby_blocks: measure('snapshot.blocks', () => nearbyBlocks(bot)),
    nearby_entities: measure('snapshot.entities', () => nearbyEntities(bot)),
    // Null when the player is too far away for the bot to see them.
    player_position: speakerEntity ? point(speakerEntity.position) : null,
    player_distance: speakerEntity ? round1(speakerEntity.position.distanceTo(me)) : null,
    last_death: deathSnapshot(),
    // The job the bot is doing, like {description: "getting 20 cobblestone", progress: "12/20"}.
    task: currentTask(),
    // The mob the bot is fighting, like "zombie"; null when not fighting.
    fighting: currentFight(),
    // Who the bot is following, or null when it's staying put (or walking somewhere).
    following,
  }
}
