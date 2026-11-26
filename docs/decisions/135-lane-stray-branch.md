# Item 135: a lane made while a folder appears leaves no stray branch

| Date | Decision | Why | By | Undo by |
| --- | --- | --- | --- | --- |
| 27 Nov 2026 | `make_with` skips the take-back when the branch already existed just before `git worktree add` (read after the folder is claimed, before the add), and otherwise deletes the failed try's branch only while it is still at the commit the try used | A branch made at the developer's HEAD by someone else in that moment looks the same as ours by tip, so "not there a moment ago" is the proof that this try made it; a moved branch is someone's work | Claude | `lane.rs`, `make_with`'s "already exists" arm |
| 27 Nov 2026 | The branch delete is the shared `lane::take_back_branch`, which `undo_make` now uses too. Item 102f's `lane_helper::take_back` (unmerged, on `feat/helper-snapshot`) still has its own copy | 102f is not on `pilot/week-1` yet, so its file cannot be edited here; once merged, its `take_back` can call `lane::take_back_branch` | Claude | Replace the tail of `take_back` with the shared call |
