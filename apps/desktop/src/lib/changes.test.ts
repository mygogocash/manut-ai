import { describe, expect, it, vi } from "vitest";
import { changes } from "./changes";

describe("the shared listener set", () => {
  it("tells each listener once per emit and stops after the undo", () => {
    const c = changes();
    const a = vi.fn();
    const off = c.subscribe(a);
    c.emit();
    off();
    c.emit();
    expect(a).toHaveBeenCalledTimes(1);
    expect(c.size()).toBe(0);
  });

  it("keeps one set per call, so one module never tells another's readers", () => {
    const one = changes();
    const two = changes();
    const a = vi.fn();
    one.subscribe(a);
    two.emit();
    expect(a).not.toHaveBeenCalled();
  });

  it("emit is live: a listener added while telling is told in the same pass, a removed one is skipped", () => {
    const c = changes();
    const late = vi.fn();
    const skipped = vi.fn();
    let offSkipped = () => {};
    c.subscribe(() => {
      c.subscribe(late);
      offSkipped();
    });
    offSkipped = c.subscribe(skipped);
    c.emit();
    expect(late).toHaveBeenCalledTimes(1);
    expect(skipped).not.toHaveBeenCalled();
  });

  it("emitSnapshot tells the listeners that were there when it began, even if one is removed meanwhile", () => {
    const c = changes();
    const second = vi.fn();
    let off = () => {};
    c.subscribe(() => off());
    off = c.subscribe(second);
    c.emitSnapshot();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("subscribing the same function twice keeps one entry, as a Set does", () => {
    const c = changes();
    const f = vi.fn();
    c.subscribe(f);
    c.subscribe(f);
    c.emit();
    expect(f).toHaveBeenCalledTimes(1);
  });
});
