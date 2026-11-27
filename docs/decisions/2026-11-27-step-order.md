# Browser steps handed out in the order they were asked for

| Date | Decision | Why | By | Undo by |
| --- | --- | --- | --- | --- |
| 27 Nov 2026 | The sign-in vault gives each browser step a number in the order it was queued (`seq`, from one counter key outside the steps' prefix, written with the step) and hands steps out by their time, then that number, then their id; a step queued before this sorts as 0; the counter goes with a wipe | Found while gating item 102j-2: `test/browser-steps.test.ts` failed about one run in four, because steps queued in the same millisecond were sorted by their random ids. An outpost could then be handed sign in or read before open, and act on the wrong page. A Durable Object lets no other request's storage call in while one of its own is in flight, so the counter needs no lock | Claude | `stepOrder` and `nextStepSeq` in `apps/api/src/sign-in-vault.ts` |
