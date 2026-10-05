// Pathfinder movement rules for the companion: what it may walk through, open, dig, place and fall.
import pathfinderPkg from 'mineflayer-pathfinder'

const { Movements } = pathfinderPkg

// Wooden doors and fence gates open by hand; iron ones need redstone.
const opensByHand = (name) => (name.endsWith('_door') || name.endsWith('_fence_gate')) && !name.startsWith('iron_')

// How far around a saved place (home, the mine...) the bot never digs or places blocks.
export const protectedRadius = 16

const manMadeSuffixes = /(_planks|_slab|_stairs|_wall|_fence|_fence_gate|_door|_trapdoor|_wool|_carpet|_concrete|_concrete_powder|_glass|_glass_pane|_bed|_banner|_sign|_hanging_sign|_button|_pressure_plate|_bricks|_brick|_wood|_tiles|glazed_terracotta|_candle|_shulker_box)$/
const manMadePrefixes = /^(stripped_|polished_|smooth_|cut_|chiseled_|waxed_)/
const manMadeNames = new Set([
  'glass', 'glass_pane', 'tinted_glass', 'cobblestone', 'mossy_cobblestone', 'bricks', 'bookshelf',
  'chest', 'trapped_chest', 'barrel', 'furnace', 'blast_furnace', 'smoker', 'crafting_table', 'anvil',
  'enchanting_table', 'brewing_stand', 'cauldron', 'lectern', 'composter', 'loom', 'cartography_table',
  'fletching_table', 'smithing_table', 'stonecutter', 'grindstone', 'bell', 'beacon', 'jukebox', 'note_block',
  'torch', 'wall_torch', 'soul_torch', 'soul_wall_torch', 'redstone_torch', 'redstone_wall_torch',
  'lantern', 'soul_lantern', 'campfire', 'soul_campfire', 'ladder', 'scaffolding', 'iron_bars', 'chain',
  'hay_block', 'glowstone', 'sea_lantern', 'flower_pot', 'end_rod', 'lodestone', 'respawn_anchor', 'target',
  'lever', 'redstone_wire', 'repeater', 'comparator', 'hopper', 'dropper', 'dispenser', 'observer',
  'piston', 'sticky_piston', 'rail', 'powered_rail', 'detector_rail', 'activator_rail',
  'farmland', 'dirt_path', 'wheat', 'carrots', 'potatoes', 'beetroots', 'melon_stem', 'pumpkin_stem',
])

// Blocks a player probably placed. The bot never breaks these, even while gathering.
export function isManMade(name) {
  return manMadeNames.has(name) || manMadeSuffixes.test(name) || manMadePrefixes.test(name)
}

// Saved places ({x, y, z, dimension}), kept up to date from the backend (see index.js).
let protectedSpots = []

export function setProtectedSpots(spots) {
  protectedSpots = spots ?? []
}

// The saved places themselves, e.g. for finding the base's chests.
export const protectedPlaces = () => protectedSpots

// True if a position is within protectedRadius (horizontally) of a saved place in this dimension.
export function isProtected(pos, dimension) {
  return protectedSpots.some((s) => s.dimension === dimension && Math.hypot(pos.x - s.x, pos.z - s.z) <= protectedRadius)
}

// What each dug or placed block costs while just walking, in "steps". High enough that the bot
// always walks around when there's a reasonable way, but can still dig or pillar out of a hole.
const lastResortCost = 15

export class CompanionMovements extends Movements {
  /**
   * @param gather false while following or walking somewhere: dig or pillar up only as a last resort
   *   (to get out of a hole, say). true during gathering jobs: dig and build freely.
   * Either way, never man-made blocks and never within protectedRadius of a saved place.
   */
  constructor(bot, { gather = false } = {}) {
    super(bot)
    this.canDig = true
    this.maxDropDown = 3 // falls of more than 3 blocks hurt
    this.liquidCost = 5 // walk around water rather than swim through it when there's a reasonable way
    // Never walk into a portal by accident: it would carry the bot to another dimension. Going
    // through one on purpose steps in by hand (travel.js).
    for (const name of ['nether_portal', 'end_portal', 'end_gateway']) {
      const block = bot.registry.blocksByName[name]
      if (block) this.blocksToAvoid.add(block.id)
    }
    // The library's canOpenDoors only covers fence gates; add wooden doors.
    this.canOpenDoors = true
    for (const block of bot.registry.blocksArray) {
      if (opensByHand(block.name)) this.openable.add(block.id)
      if (isManMade(block.name)) this.blocksCantBreak.add(block.id)
    }
    // Weight 100 means "never" to the pathfinder. Checked live, so new saved places count at once.
    const guard = (block) => (isProtected(block.position, bot.game.dimension) ? 100 : 0)
    this.exclusionAreasBreak.push(guard)
    this.exclusionAreasPlace.push(guard)
    if (!gather) {
      this.digCost = lastResortCost
      this.placeCost = lastResortCost
    }
  }

  // The library judges doors and gates by block type, so it sees every one as solid, open or not.
  // Look at the actual state instead.
  getBlock(pos, dx, dy, dz) {
    const b = super.getBlock(pos, dx, dy, dz)
    if (!b.openable) return b
    const { open, half } = b.getProperties()
    // Open: walk straight through. Upper half of a closed door: opening the lower half opens both.
    // The height has to go too: it comes from the door's collision shape, and a 1-block-tall door
    // panel otherwise looks like a step to jump onto, which the bot then can't do.
    if (open || half === 'upper') {
      Object.assign(b, { safe: true, physical: false, openable: false, height: b.position.y })
    }
    return b
  }
}
