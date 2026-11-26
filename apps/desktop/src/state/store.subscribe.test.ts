// The store tells its readers through `changes()` (src/lib/changes.ts) since item 125d, in the order its own Set did
// before: a copy of the listeners is taken first, so a listener that removes another, or adds one, while it is told
// changes who hears only the next change. A view that unsubscribes while React re-renders depends on that.
import { expect, it } from "vitest";
import { createStore, type BridgeLike } from "./store";

// Only dispatch and subscribe are used here, and neither reaches the bridge.
const bridge = {} as BridgeLike;

it("tells every listener of a change, and stops telling one that unsubscribed", () => {
  const s = createStore(bridge);
  const told: string[] = [];
  const offA = s.subscribe(() => told.push("a"));
  s.subscribe(() => told.push("b"));
  s.dispatch({ type: "ui.theme", theme: "dark" });
  offA();
  s.dispatch({ type: "ui.theme", theme: "light" });
  expect(told).toEqual(["a", "b", "b"]);
});

it("tells the listeners as they stood when the change came: one removed or added meanwhile waits for the next", () => {
  const s = createStore(bridge);
  const told: string[] = [];
  let offB = () => {};
  let first = true;
  s.subscribe(() => {
    told.push("a");
    if (!first) return;
    first = false;
    offB();
    s.subscribe(() => told.push("c"));
  });
  offB = s.subscribe(() => told.push("b"));
  s.dispatch({ type: "ui.theme", theme: "dark" });
  expect(told).toEqual(["a", "b"]);
  s.dispatch({ type: "ui.theme", theme: "light" });
  expect(told).toEqual(["a", "b", "a", "c"]);
});

it("tells nobody when an action leaves the state as it was", () => {
  const s = createStore(bridge);
  let told = 0;
  s.subscribe(() => (told += 1));
  s.dispatch({ type: "ui.theme", theme: "dark" });
  s.dispatch({ type: "chat.forget", bot: "nobody" });
  s.dispatch({ type: "send.ok", bot: "nobody", id: "m1", now: 1 });
  expect(told).toBe(1);
});
