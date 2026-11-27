# Item 102l: Buddy's chat on the Connected runtime, then the reach cards

| Date | Decision | Why | By | Undo by |
| --- | --- | --- | --- | --- |
| 27 Nov 2026 | Build 102l, deployed to the dev API only | The owner's answer | Owner | Stop at any phase |
| 27 Nov 2026 | 102l starts with a design pass (`docs/connected-chat.md`) and is built as 102l-1 to 102l-3, with real answers (102l-4) waiting on the owner's Anthropic key. Buddy's chat comes first, as one route on the owner's session through the model gateway under the shop's cap; chat threads are not tasks; the reach cards come last, with R10 unchanged | The API had no chat and a shop session cannot make a task, so the cards had nothing to stand on. The gateway's rule of no model route was about an operator key spending from outside; a route on the owner's session, inside the shop's own cap, keeps what that rule protects | Claude | Rewrite the design |
| 27 Nov 2026 | Four questions go to the owner before 102l-1 merges: the chat wanted for the pilot with each message billed, owner only or helpers too, how long messages are kept, and whether Buddy may later start work from a chat | Each spends money, decides who may, or keeps customers' words | Claude | None |
