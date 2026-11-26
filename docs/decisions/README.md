# Decisions

Every product, design and technical call made while building. "Owner" means the owner decided; "Claude" means Claude
took its own recommendation under the standing permission of 23 Nov 2026 (reversible calls only). Anything about
money, legal, launch dates or customers goes to the owner.

## Where they are

- [`archive.md`](archive.md): every decision up to 26 Nov 2026, in one table, newest first. It is frozen: nothing is
  added to it, so it is the row a comment or a doc means when it cites "docs/decisions.md".
- One file per item since then, named `<item>-<short-name>.md`, for example [`128-conflict-free.md`](128-conflict-free.md).

Until item 128 every item added its rows at the top of one table, so two items built side by side conflicted there in
nearly every merge (items 120, 121, 122, 124, 105, 125a and 125c on 26 Nov alone). A file of its own per item never
conflicts.

## Adding a decision

1. If your item has no file yet, create `docs/decisions/<item>-<short-name>.md`:
   - `<item>` is the item's id as `docs/plan.md` writes it, in lower case: `128`, `125d`, or `dec-35` for December
     item 35.
   - `<short-name>` is a few words of the item in lower case with hyphens, usually its branch's name without the
     `feat/` or `chore/`.
   - A call that belongs to no item (the owner's, made in a conversation) is `<yyyy-mm-dd>-<short-name>.md`; a cloud
     routine's is `<yyyy-mm-dd>-cloud-<task-id>.md`.
2. The file is a heading that names the item and the same five-column table as the archive, newest row first:

   ```md
   # Item 128: shared files that many agents can add to without colliding

   | Date | Decision | Why | By | Undo by |
   | --- | --- | --- | --- | --- |
   | 26 Nov 2026 | What was decided | Why, and what it costs | Claude | Where to change it back |
   ```

3. Add each further decision of the item as a row at the top of that same table. A decision that replaces an older one
   says so in its own row ("replaces the 24 Nov row on ...") and leaves the older row as it is.

## Finding one

`grep -rn "<word>" docs/decisions/` searches the archive and every item's file at once. `ls docs/decisions/` lists the
items that made decisions.
