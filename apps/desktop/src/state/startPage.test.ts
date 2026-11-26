// The page a person opens while the app is still connecting stays open (26 Nov): the start chooses the first member behind it
// and neither its chat nor Home is put over it. Before, the start selected the member's chat and then Home, and undid a click
// on the side menu made in its first moments (seen as a browser spec that clicked Customize at once and stayed on Home).
import { expect, it } from "vitest";
import { createStore, type BridgeLike } from "./store";

function fixture() {
  let listed!: () => void;
  const bots = new Promise<void>((r) => (listed = r));
  const bridge: BridgeLike = {
    connect: async () => {},
    onAny: () => () => {},
    onStatus: () => () => {},
    request: (async (op: string) => {
      if (op === "hello") return { bridge: "mock", version: "test", hermes: { home: "/scratch" } };
      if (op === "bots.list") {
        await bots;
        return { bots: [{ name: "kami", display_name: "Kami", is_default: false, model: "m", provider: "p", description: "", status: "online", running: false }] };
      }
      if (op === "chat.open") return { session_id: "s-kami", messages: [], running: false, model: "m", provider: "p", reasoning: "high" };
      if (op === "elsewhere.list") return { sessions: [] };
      if (op === "routines.list") return { routines: [] };
      if (op === "automations.list") return { automations: [] };
      if (op === "thread.list") return { threads: [] };
      if (op === "models.options") return { providers: [], current: { model: "m", provider: "p", reasoning: "high" }, reasoning_levels: [] };
      return {};
    }) as BridgeLike["request"],
  };
  return { store: createStore(bridge), listed: () => listed() };
}
const settle = () => new Promise((r) => setTimeout(r, 30));

it("a page opened while the app connects stays, with the first member chosen behind it", async () => {
  const f = fixture();
  const started = f.store.actions.init();
  await settle();
  f.store.actions.openPage("customize");
  f.listed();
  await started;
  await settle();
  expect(f.store.getState().ui.view).toBe("customize");
  expect(f.store.getState().selectedBot).toBe("kami");
});

it("with nothing opened meanwhile, the app still starts on Home with the first member chosen", async () => {
  const f = fixture();
  const started = f.store.actions.init();
  f.listed();
  await started;
  await settle();
  expect(f.store.getState().ui.view).toBe("home");
  expect(f.store.getState().selectedBot).toBe("kami");
});
