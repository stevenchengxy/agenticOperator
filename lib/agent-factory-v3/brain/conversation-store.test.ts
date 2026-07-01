// The conversation store is what makes the factory a chatbot: it keeps a
// conversation's messages + brain ctx alive across user turns. Deterministic.

import { describe, it, expect } from "vitest";
import { getConversation, hasConversation, saveConversation, disposeConversation } from "./conversation-store";
import type { ChatMsg } from "./stream-gateway";
import type { BrainCtx } from "./types";

const fakeCtx = (domain: string) => ({ domain, specs: [], ontology: null } as unknown as BrainCtx);
const msgs = (n: number): ChatMsg[] => Array.from({ length: n }, (_, i) => ({ role: "user" as const, content: `m${i}` }));

describe("conversation-store", () => {
  it("saves + retrieves a conversation (messages + ctx survive)", () => {
    saveConversation("c1", msgs(3), fakeCtx("招聘-v1"));
    const got = getConversation("c1");
    expect(got).toBeTruthy();
    expect(got!.messages.length).toBe(3);
    expect(got!.ctx.domain).toBe("招聘-v1");
    expect(hasConversation("c1")).toBe(true);
    disposeConversation("c1");
  });

  it("an empty id never persists or matches", () => {
    saveConversation("", msgs(1), fakeCtx("x"));
    expect(getConversation("")).toBeUndefined();
    expect(hasConversation("")).toBe(false);
  });

  it("dispose removes the conversation", () => {
    saveConversation("c2", msgs(1), fakeCtx("x"));
    expect(hasConversation("c2")).toBe(true);
    disposeConversation("c2");
    expect(hasConversation("c2")).toBe(false);
  });

  it("LRU-evicts the oldest beyond the cap (no unbounded growth)", () => {
    // write well past the cap; the earliest keys must be gone, the latest kept.
    for (let i = 0; i < 60; i++) saveConversation(`k${i}`, msgs(1), fakeCtx("d"));
    expect(hasConversation("k0")).toBe(false);   // oldest evicted
    expect(hasConversation("k59")).toBe(true);   // newest kept
    // re-saving a key bumps its recency
    saveConversation("k30", msgs(2), fakeCtx("d"));
    for (let i = 60; i < 80; i++) saveConversation(`k${i}`, msgs(1), fakeCtx("d"));
    expect(hasConversation("k30")).toBe(true);    // bumped → survived the next wave
    for (let i = 0; i < 80; i++) disposeConversation(`k${i}`);
  });
});
