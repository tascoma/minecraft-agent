// Pathfinder movement rules for the companion: what it may walk through, open, dig and fall.
import pathfinderPkg from 'mineflayer-pathfinder'

const { Movements } = pathfinderPkg

// Wooden doors and fence gates open by hand; iron ones need redstone.
const opensByHand = (name) => (name.endsWith('_door') || name.endsWith('_fence_gate')) && !name.startsWith('iron_')

export class CompanionMovements extends Movements {
  constructor(bot) {
    super(bot)
    this.canDig = false // don't break the player's builds while walking around
    this.maxDropDown = 3 // falls of more than 3 blocks hurt
    this.liquidCost = 5 // walk around water rather than swim through it when there's a reasonable way
    // The library's canOpenDoors only covers fence gates; add wooden doors.
    this.canOpenDoors = true
    for (const block of bot.registry.blocksArray) {
      if (opensByHand(block.name)) this.openable.add(block.id)
    }
  }

  // The library judges doors and gates by block type, so it sees every one as solid, open or not.
  // Look at the actual state instead.
  getBlock(pos, dx, dy, dz) {
    const b = super.getBlock(pos, dx, dy, dz)
    if (!b.openable) return b
    const { open, half } = b.getProperties()
    // Open: walk straight through. Upper half of a closed door: opening the lower half opens both.
    if (open || half === 'upper') Object.assign(b, { safe: true, physical: false, openable: false })
    return b
  }
}
