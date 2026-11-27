# Item 134: the join page's countdown test must not depend on the clock

| Date | Decision | Why | By | Undo by |
| --- | --- | --- | --- | --- |
| 27 Nov 2026 | The countdown test pins the system time before anything renders, lets the page's interval effect run (`await act(async () => {})`) before the first advance, and checks 0:42, 0:01 and the offer at exactly 60 seconds. The page is unchanged. | The old test froze `Date` at whatever real moment it started and advanced at once after the text showed, while React may still be starting the page's interval. A slow runner could meet that gap. Pinning and flushing make every second the test's own, and the 0:01 step fails a count that is off by one. | Claude | Revert the commit |
| 27 Nov 2026 | Both JoinPage entries leave the handoff's flaky list. The other tests that use fake time (`MakeRoutineForm`, `RoutinesView`, `ConnectionsView`) already pin `Date` and wait on no countdown, so they stay as they are. | Nothing else in `apps/web/test` reads a countdown against the clock. | Claude | Revert the commit |
