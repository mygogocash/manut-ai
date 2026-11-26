// Each Playwright worker runs against a stand-in of its own (e2e/standIns.ts, item 129): a mock bridge and a dev server
// that dials it, on the base ports plus twice the worker's parallelIndex. This checks it from inside a worker, wherever
// the run puts this file: the ports the specs read are the worker's own, the page is served by the worker's own dev
// server, and that page talks to the worker's own bridge, which records its calls and no one else's.
import { expect, test } from "@playwright/test";
import { chatOpen } from "./start";

const MOCK = Number(process.env.MANUT_MOCK_PORT || 5308);

async function mock(op: string): Promise<any> {
  const ws = new WebSocket(`ws://127.0.0.1:${MOCK}/?token=e2e`);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("mock websocket error"));
  });
  const reply = await new Promise<any>((res) => {
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.id === "x1") res(msg);
    };
    ws.send(JSON.stringify({ id: "x1", op }));
  });
  ws.close();
  expect(reply.ok, JSON.stringify(reply)).toBe(true);
  return reply.result;
}

test("a worker's specs reach its own dev server and its own mock bridge", async ({ page, baseURL }, testInfo) => {
  const i = testInfo.parallelIndex;
  const app = Number(process.env.MANUT_E2E_BASE_PORT) + 2 * i;
  const bridge = Number(process.env.MANUT_E2E_BASE_MOCK_PORT) + 2 * i;
  expect(Number(process.env.MANUT_PORT)).toBe(app);
  expect(MOCK).toBe(bridge);
  expect(baseURL).toBe(`http://127.0.0.1:${app}`);

  await mock("mock.reset");
  expect((await mock("mock.calls")).calls).toEqual([]);
  await page.goto("/");
  expect(new URL(page.url()).port).toBe(String(app));
  await chatOpen(page);
  // the page's start reached this worker's bridge: its calls are in this bridge's log
  await expect.poll(async () => (await mock("mock.calls")).calls.length).toBeGreaterThan(0);
});
