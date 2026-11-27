# The owner's goal of 27 Nov 2026: every feature not done yet, macOS first, then iOS

The owner set the goal in the lead's session on the evening of 27 Nov: "continue implement all features that's not done
yet, focus on macos first then ios", and pointed at Paradev (`ParadevAI/Paradev`, MIT) as a resource "to maximize for
code mode". The calls below are how the lead reads that goal.

| Date | Decision | Why | By | Undo by |
| --- | --- | --- | --- | --- |
| 27 Nov 2026 | Paradev is studied first as item 138 (`docs/paradev-parity.md`, rows from 139), in the form of `docs/t3code-parity.md`: each feature that bears on the code mode, what Manut AI has of it, and what can be lifted under its MIT licence with a credit | A survey checked against the code keeps the plan from guessing, as the T3 Code survey did; Paradev's desktop is Electron and Manut AI's is Tauri, so only some modules lift as they are | Claude | Drop item 138's rows |
| 27 Nov 2026 | Item 108's phases go ahead on the design's recommended answers to its nine questions, each recorded in `docs/decisions/108-multi-machine.md` as it is built; the questions stay open, and an answer the owner gives later changes the phase it touches. The consent words (question 9), a second Mac, a real phone and any new dependency stay the owner's | The goal asks for every feature not done; each answer is reversible and every phase is built switched off, as 78's were | Claude | Stop at any phase; `docs/multi-machine.md` lists each phase's undo |
| 27 Nov 2026 | iOS comes back after the macOS items, replacing the owner's "leave iOS for now" of earlier on 27 Nov: a design pass first (what Paradev's mobile app and the installed web app `/app/` each offer, Tauri's iOS target or a native app, signing with the business's Apple developer account), then phases | The owner's own goal names iOS after macOS; until a design exists the installed web app keeps covering the phone | Owner (the goal), Claude (the order) | Park iOS again |
| 27 Nov 2026 | LINE, payments and Thai stay parked though the goal says "all features": each was parked by the owner for a reason the goal does not change (a test LINE Official Account, the billing questions, Thai copy) | Building them would reach real customers or money, which needs the owner's own word each time | Claude | The owner unparks one |
