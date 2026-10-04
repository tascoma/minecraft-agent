// Builds the snapshot of the bot's situation that is sent to the backend with every chat.
import { lastDeathInfo } from './survival.js'
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

// Most blocks of one type the bot counts. Searching per type means common blocks
// (water, sand) can't use up the search and hide rarer ones (logs, ores).
const maxPerType = 100

function nearbyBlocks(bot) {
  const me = bot.entity.position
  const groups = []
  for (const block of bot.registry.blocksArray) {
    if (!interestingBlock(block.name)) continue
    const found = bot.findBlocks({ matching: block.id, maxDistance: scanRadius, count: maxPerType })
    // findBlocks returns the nearest first.
    if (found.length === 0) continue
    groups.push({
      name: block.name,
      count: found.length,
      // The search stopped at the cap, so there are probably more.
      more: found.length === maxPerType,
      nearest: point(found[0]),
      distance: round1(me.distanceTo(found[0])),
    })
  }
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

export function snapshot(bot, speaker) {
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
    nearby_blocks: nearbyBlocks(bot),
    nearby_entities: nearbyEntities(bot),
    // Null when the player is too far away for the bot to see them.
    player_position: speakerEntity ? point(speakerEntity.position) : null,
    player_distance: speakerEntity ? round1(speakerEntity.position.distanceTo(me)) : null,
    last_death: deathSnapshot(),
    // The job the bot is doing, like {description: "getting 20 cobblestone", progress: "12/20"}.
    task: currentTask(),
  }
}
