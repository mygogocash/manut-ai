# Item 128: shared files that many agents can add to without colliding

| Date | Decision | Why | By | Undo by |
| --- | --- | --- | --- | --- |
| 26 Nov 2026 | Decisions are one file per item in `docs/decisions/` (`<item>-<short-name>.md`, the archive's five columns, newest first). The old table moved to `docs/decisions/archive.md` unchanged, as a pure rename in its own commit, and `docs/decisions.md` is a short note pointing there, so the 50-odd comments and docs that cite "docs/decisions.md" still land somewhere. A branch made before this adds rows to the old file: the lead keeps the note and moves those rows into the branch's own file (`lead-merge`) | Every item added rows at the top of one table, which conflicted in nearly every merge on 26 Nov. A file per item cannot conflict with another item's; the rename on its own keeps `git log --follow` and blame on every old row | Claude | Move `archive.md` back to `docs/decisions.md` and append the per-item files' rows to it |
