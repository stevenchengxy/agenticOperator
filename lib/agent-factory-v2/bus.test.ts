import { describe, it, expect } from "vitest";
import { Bus } from "./bus";
import type { BuildEvent } from "./types";

describe("Bus", () => {
  it("delivers events to subscribers in order with a monotonic seq", () => {
    const bus = new Bus();
    const got: Array<{ seq: number; e: BuildEvent }> = [];
    bus.subscribe((seq, e) => got.push({ seq, e }));
    bus.emit({ t: "log", line: "a" });
    bus.emit({ t: "log", line: "b" });
    expect(got.map((x) => x.seq)).toEqual([0, 1]);
    expect(got.map((x) => (x.e as { line: string }).line)).toEqual(["a", "b"]);
  });
  it("a throwing subscriber never breaks emit or other subscribers", () => {
    const bus = new Bus();
    const seen: string[] = [];
    bus.subscribe(() => { throw new Error("boom"); });
    bus.subscribe((_s, e) => seen.push(e.t));
    expect(() => bus.emit({ t: "log", line: "x" })).not.toThrow();
    expect(seen).toEqual(["log"]);
  });
});
