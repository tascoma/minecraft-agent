---
name: enchanting
description: How to set up enchanting (the enchanting table, books and bookshelves, lapis and levels). Load when the player asks about enchanting, an enchanting table or bookshelves.
---

1. The table: 2 diamonds, 4 obsidian and a book (`make_item` "enchanting_table"). Obsidian needs a diamond pickaxe; diamonds see find-diamonds.
2. A book is 3 paper and a leather: paper from sugar cane (it grows by water), leather from cows (`hunt` "cow"). `make_item` "book" gathers and hunts what's missing.
3. Bookshelves (6 planks and 3 books each) make better enchantments: 15 of them, one block away from the table with nothing in between, give the best. That's 45 books, so suggest starting with a few.
4. Place the table at the base (`place_block` "enchanting_table" with the place) and the bookshelves around it.
5. Enchanting itself costs lapis lazuli (`mine_for` "lapis") and experience levels. You can't enchant yet; the player does it at the table.
