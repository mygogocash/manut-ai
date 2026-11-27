// The Your Mac tab as a person sees it (src/app/mac/MacTab.tsx), on practice mode's pretend Mac: not available, the
// code form with and without a camera reader, a link opened outside the installed app, the digits, the passkey step,
// the paired list, a chat with its asks shown whole, the four answers and nothing else, the greyed view, and Forget.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { answerOf, MacTab } from "../src/app/mac/MacTab";
import { PRACTICE_DIGITS, practiceBackend } from "../src/app/mac/practice";
import type { Scanner } from "../src/app/mac/scan";
import { en as s } from "../src/app/strings";

const m = s.mac;
/// Practice's waits, made immediate.
const quick = { set: (run: () => void) => setTimeout(run, 0), clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) };
const noCamera: Scanner = { available: false, scan: async () => null };

function show(options: { relay?: "on" | "off"; scanner?: Scanner; opened?: { link: string; installed: boolean } } = {}) {
  const practice = practiceBackend({ relay: options.relay ?? "on", timers: quick });
  render(
    <main>
      <MacTab s={s} backend={practice} practice={practice} scanner={options.scanner ?? noCamera} opened={options.opened ?? null} />
    </main>,
  );
  return practice;
}

async function pairInPractice(practice: ReturnType<typeof practiceBackend>) {
  fireEvent.change(await screen.findByLabelText(m.pasteLabel), { target: { value: "https://dev.manut.xyz/app/#pair=practice" } });
  fireEvent.click(screen.getByRole("button", { name: m.pair }));
  expect(await screen.findByRole("img", { name: m.digitsSpoken(PRACTICE_DIGITS) })).toBeTruthy();
  expect(screen.getByRole("heading", { name: m.digitsTitle })).toBeTruthy();
  act(() => practice.typeDigits());
  fireEvent.click(await screen.findByRole("button", { name: m.makePasskey }));
  await screen.findByRole("heading", { name: m.states.needs_you });
}

describe("the Your Mac tab", () => {
  it("offers the code while the relay is off to a phone not yet paired, since a code that names the Mac's tailnet pairs over it (item 78f-2d)", async () => {
    show({ relay: "off" });
    expect(await screen.findByRole("heading", { name: m.scanTitle })).toBeTruthy();
    expect(screen.queryByText(m.unavailableTitle)).toBeNull();
  });

  it("asks for the Mac's code: Scan only where the browser can read one, and the pasted link always", async () => {
    show();
    expect(await screen.findByRole("heading", { name: m.scanTitle })).toBeTruthy();
    expect(screen.queryByRole("button", { name: m.scan })).toBeNull();
    expect(await screen.findByText(m.noScanner)).toBeTruthy();
    // Pair with nothing pasted says what to do, and pairs nothing.
    fireEvent.click(screen.getByRole("button", { name: m.pair }));
    expect(await screen.findByText(m.pasteFirst)).toBeTruthy();
    expect(screen.queryByTestId("mac-digits")).toBeNull();
  });

  it("scans only when Scan is pressed, and pairs with what it read", async () => {
    let asked = 0;
    const scanner: Scanner = {
      available: true,
      scan: async () => {
        asked += 1;
        return "https://dev.manut.xyz/app/#pair=AQID";
      },
    };
    show({ scanner });
    fireEvent.click(await screen.findByRole("button", { name: m.scan }));
    expect(await screen.findByRole("img", { name: m.digitsSpoken(PRACTICE_DIGITS) })).toBeTruthy();
    expect(asked).toBe(1);
  });

  it("says when the camera was refused, or the code is not Manut AI's, and pairs nothing", async () => {
    let answer: string | "refused" = "refused";
    show({ scanner: { available: true, scan: async () => answer } });
    fireEvent.click(await screen.findByRole("button", { name: m.scan }));
    expect(await screen.findByText(m.cameraRefused)).toBeTruthy();
    answer = "https://example.com/menu";
    fireEvent.click(screen.getByRole("button", { name: m.scan }));
    expect(await screen.findByText(m.scanNotCode)).toBeTruthy();
    expect(screen.queryByTestId("mac-digits")).toBeNull();
  });

  it("pairs nothing from a link opened outside the installed app, and offers to copy it", async () => {
    show({ opened: { link: "https://dev.manut.xyz/app/#pair=AQID", installed: false } });
    expect(await screen.findByRole("heading", { name: m.outsideTitle })).toBeTruthy();
    expect(screen.getByRole("button", { name: m.copyLink })).toBeTruthy();
    expect(screen.queryByLabelText(m.pasteLabel)).toBeNull();
    expect(screen.queryByTestId("mac-digits")).toBeNull();
  });

  it("fills in a link opened inside the installed app, and still waits for Pair", async () => {
    show({ opened: { link: "https://dev.manut.xyz/app/#pair=AQID", installed: true } });
    expect(((await screen.findByLabelText(m.pasteLabel)) as HTMLInputElement).value).toBe("https://dev.manut.xyz/app/#pair=AQID");
    expect(screen.queryByTestId("mac-digits")).toBeNull();
  });

  it("shows the four digits large, then the passkey step, then the chats as Needs you, Working and Done", async () => {
    const practice = show();
    await pairInPractice(practice);
    expect(screen.getByText(m.live)).toBeTruthy();
    const groups = ["needs_you", "working", "done"] as const;
    for (const state of groups) expect(screen.getByRole("heading", { name: m.states[state] })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Shop launch plan/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: m.forget })).toBeTruthy();
  });

  it("shows a chat's asks whole and offers Allow once, No, an answer and Stop, and nothing else", async () => {
    const practice = show();
    await pairInPractice(practice);
    fireEvent.click(screen.getByRole("button", { name: /Shop launch plan/ }));
    const card = await waitFor(() => {
      const found = document.querySelector('[data-ask="broadcast"]');
      if (!found) throw new Error("no card");
      return found as HTMLElement;
    });
    expect(within(card).getByText("Send a LINE broadcast")).toBeTruthy();
    expect(within(card).getByTestId("mac-command").textContent).toBe(
      'line broadcast --to all-customers --text "October sale: 20% off everything, Friday to Sunday. Show this message at the till."',
    );
    expect(within(card).getByText("in /Users/fon/shop")).toBeTruthy();
    expect(within(card).getAllByRole("button").map((b) => b.textContent)).toEqual([m.allowOnce, m.no]);
    // Nothing else: no Always allow, no message to send, no dial.
    expect(screen.queryByRole("button", { name: /always/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /send message/i })).toBeNull();
    expect(screen.getByRole("button", { name: m.stop })).toBeTruthy();
    // A link in a reply is plain text.
    expect(screen.getByText(/https:\/\/baanmali\.example\/sale/).closest("a")).toBeNull();
    expect(document.querySelectorAll("main a").length).toBe(0);
    expect(screen.getByText(m.linksNote)).toBeTruthy();

    fireEvent.click(within(card).getByRole("button", { name: m.allowOnce }));
    expect(await screen.findByText(m.notes.allowed)).toBeTruthy();
    await waitFor(() => expect(document.querySelector('[data-ask="broadcast"]')?.textContent).toContain(m.outcomes.allowed));

    const question = document.querySelector('[data-ask="day"]') as HTMLElement;
    fireEvent.click(within(question).getByRole("button", { name: m.sendAnswer }));
    expect(await within(question).findByText(m.answerFirst)).toBeTruthy();
    fireEvent.click(within(question).getByRole("button", { name: "Friday" }));
    fireEvent.click(within(question).getByRole("button", { name: m.sendAnswer }));
    expect(await screen.findByText(m.notes.answered)).toBeTruthy();
  });

  it("greys what it shows when the Mac is out of reach, with nothing to press, and says until when it holds", async () => {
    const practice = show();
    await pairInPractice(practice);
    fireEvent.click(screen.getByRole("button", { name: /Shop launch plan/ }));
    await screen.findByRole("button", { name: m.allowOnce });
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(await screen.findByText(/You're offline\. What you see was current at/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: m.allowOnce })).toBeNull();
    expect(screen.queryByRole("button", { name: m.no })).toBeNull();
    expect(screen.queryByRole("button", { name: m.stop })).toBeNull();
    expect(document.querySelector("[data-greyed]")).not.toBeNull();
  });

  it("forgets the Mac after saying what that removes, and keeps nothing of a chat anywhere", async () => {
    window.history.replaceState(null, "", "/app/#mac");
    const practice = show();
    await pairInPractice(practice);
    fireEvent.click(screen.getByRole("button", { name: /Shop launch plan/ }));
    await screen.findByRole("button", { name: m.allowOnce });
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(window.location.pathname + window.location.search + window.location.hash).toBe("/app/#mac");
    fireEvent.click(screen.getByRole("button", { name: m.allChats }));
    fireEvent.click(await screen.findByRole("button", { name: m.forget }));
    expect(screen.getByText(m.forgetBody)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: m.forgetConfirm }));
    expect(await screen.findByRole("heading", { name: m.scanTitle })).toBeTruthy();
    expect(await practice.vault.load()).toBeNull();
  });
});

describe("a question's answer, as the Mac reads it", () => {
  it("is the typed text or the choice, a JSON list for several, or null", () => {
    expect(answerOf(["Friday"], "", false)).toBe("Friday");
    expect(answerOf(["Friday"], " Sunday ", false)).toBe("Sunday");
    expect(answerOf(["Friday", "Saturday"], "", true)).toBe('["Friday","Saturday"]');
    expect(answerOf([], "", true)).toBeNull();
    expect(answerOf([], "", false)).toBeNull();
  });
});
