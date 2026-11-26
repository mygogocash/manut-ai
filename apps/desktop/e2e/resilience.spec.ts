// Inputs the closing verify broke (D2–D4): an offline bot, a blank away label, the bridge dying mid-turn.
import { expect, test, type Page } from "@playwright/test";
import { chatOpen, openChat } from "./start";

const MOCK = Number(process.env.MANUT_MOCK_PORT || 5308);

/** The mock bridge's own reset. A spec before this one in the same worker may leave Kami's turn running (prompt-history's held
 *  prompt does): a message typed then waits in the queue instead of crossing the socket, and the mid-turn test sees no send. */
async function resetMock(): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${MOCK}/?token=e2e`);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("mock websocket error"));
  });
  await new Promise<void>((res) => {
    ws.onmessage = (m) => {
      if (JSON.parse(String(m.data)).id === "rs1") res();
    };
    ws.send(JSON.stringify({ id: "rs1", op: "mock.reset" }));
  });
  ws.close();
}

test.beforeEach(async () => {
  await resetMock();
});

async function open(page: Page) {
  await page.goto("/");
  await chatOpen(page);
  await expect(page.getByTestId("bubble-user").first()).toBeVisible();
}

test("an offline bot shows why instead of Loading… forever", async ({ page }) => {
  await page.routeWebSocket(/127\.0\.0\.1/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.op === "chat.open" && msg.bot === "friren") {
        ws.send(JSON.stringify({ id: msg.id, ok: false, error: { code: "bot_offline", message: "gateway could not start" } }));
        return;
      }
      server.send(raw);
    });
  });
  await open(page);
  await openChat(page, "friren");
  const err = page.getByTestId("chat-error");
  await expect(err).toBeVisible();
  await expect(err).toContainText("gateway could not start");
  await expect(page.getByTestId("timeline").getByText("Loading…")).toHaveCount(0);
});

test("an away session with a blank label still gets a title", async ({ page }) => {
  await page.routeWebSocket(/127\.0\.0\.1/, (ws) => {
    const server = ws.connectToServer();
    const ops = new Map<string, string>();
    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw));
      ops.set(msg.id, msg.op);
      server.send(raw);
    });
    server.onMessage((raw) => {
      const msg = JSON.parse(String(raw));
      if (ops.get(msg.id) === "elsewhere.list" && msg.ok) {
        for (const s of msg.result.sessions) if (s.source === "slack") { s.label = ""; s.title = ""; s.last_reply = null; }
        ws.send(JSON.stringify(msg));
        return;
      }
      ws.send(raw);
    });
  });
  await open(page);
  await page.getByTestId("places").click();
  const titles = await page.getByTestId("details-panel").locator("[data-testid=where-row] .t1").allTextContents();
  expect(titles.length).toBeGreaterThan(0);
  for (const t of titles) expect(t.trim()).not.toBe("");
  expect(titles).toContain("Slack session");
});

test("bridge lost mid-turn: activity ends Stopped, Stop goes away, nothing is resent", async ({ page }) => {
  let sends = 0;
  let drop: (() => void) | null = null;
  await page.routeWebSocket(/127\.0\.0\.1/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.op === "chat.send") sends++;
      server.send(raw);
    });
    drop = () => ws.close({ code: 1011, reason: "bridge died" });
  });
  await open(page);
  await page.getByTestId("composer").fill("run something long");
  await page.getByTestId("composer").press("Enter");
  await expect(page.getByTestId("stop")).toBeVisible();
  // Stop shows the moment Enter is pressed, before the send has crossed the socket. Wait for the send itself, or a
  // loaded runner closes the socket first and the test sees no send at all (sends 0, not 1).
  await expect.poll(() => sends).toBe(1);
  drop!();
  // Checked before the client reconnects: the lost turn is closed as stopped, not left live.
  await expect(page.getByTestId("stop")).toHaveCount(0, { timeout: 1000 });
  await expect(page.getByTestId("timeline")).toContainText(/Stopped after/);
  await page.waitForTimeout(2500); // reconnect window
  expect(sends).toBe(1);
});
