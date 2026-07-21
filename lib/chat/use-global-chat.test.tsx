import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useGlobalChat } from "./use-global-chat";

beforeEach(() => {
  if (typeof window !== "undefined") window.localStorage.clear();
});

afterEach(() => cleanup());

describe("useGlobalChat", () => {
  it("starts with an empty current session and empty history list", () => {
    const { result } = renderHook(() => useGlobalChat());
    expect(result.current.currentSession.messages).toEqual([]);
    expect(result.current.sessions).toEqual([]);
  });

  it("appendMessage adds to current session", () => {
    const { result } = renderHook(() => useGlobalChat());
    act(() => result.current.appendMessage({ role: "user", content: "hi" }));
    expect(result.current.currentSession.messages).toHaveLength(1);
    expect(result.current.currentSession.messages[0]?.content).toBe("hi");
  });

  it("auto-titles current session from first user message", () => {
    const { result } = renderHook(() => useGlobalChat());
    act(() => result.current.appendMessage({ role: "user", content: "what runs failed today?" }));
    expect(result.current.currentSession.title).toContain("what runs failed");
  });

  it("newSession archives current to sessions list", () => {
    const { result } = renderHook(() => useGlobalChat());
    act(() => result.current.appendMessage({ role: "user", content: "first" }));
    act(() => result.current.newSession());
    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.currentSession.messages).toEqual([]);
  });

  it("newSession does NOT archive an empty current session", () => {
    const { result } = renderHook(() => useGlobalChat());
    act(() => result.current.newSession());
    expect(result.current.sessions).toEqual([]);
  });

  it("switchSession loads a previous session", () => {
    const { result } = renderHook(() => useGlobalChat());
    act(() => result.current.appendMessage({ role: "user", content: "first" }));
    act(() => result.current.newSession());
    const firstId = result.current.sessions[0]!.id;
    act(() => result.current.appendMessage({ role: "user", content: "second" }));
    act(() => result.current.switchSession(firstId));
    expect(result.current.currentSession.messages[0]?.content).toBe("first");
  });

  it("deleteSession removes from sessions list", () => {
    const { result } = renderHook(() => useGlobalChat());
    act(() => result.current.appendMessage({ role: "user", content: "x" }));
    act(() => result.current.newSession());
    const id = result.current.sessions[0]!.id;
    act(() => result.current.deleteSession(id));
    expect(result.current.sessions).toEqual([]);
  });

  it("renameSession updates the title on current or archived session", () => {
    const { result } = renderHook(() => useGlobalChat());
    act(() => result.current.appendMessage({ role: "user", content: "hi" }));
    const id = result.current.currentSession.id;
    act(() => result.current.renameSession(id, "重命名后"));
    expect(result.current.currentSession.title).toBe("重命名后");
  });

  it("persists across remounts via localStorage", () => {
    const { result, unmount } = renderHook(() => useGlobalChat());
    act(() => result.current.appendMessage({ role: "user", content: "persist me" }));
    unmount();
    const { result: r2 } = renderHook(() => useGlobalChat());
    expect(r2.current.currentSession.messages[0]?.content).toBe("persist me");
  });

  it("clearCurrent empties messages but keeps session id intact behavior — replace with fresh session", () => {
    const { result } = renderHook(() => useGlobalChat());
    act(() => result.current.appendMessage({ role: "user", content: "x" }));
    act(() => result.current.clearCurrent());
    expect(result.current.currentSession.messages).toEqual([]);
  });

  it("replaceLastAssistant overwrites the trailing assistant message", () => {
    const { result } = renderHook(() => useGlobalChat());
    act(() => result.current.appendMessage({ role: "user", content: "q" }));
    act(() => result.current.appendMessage({ role: "assistant", content: "first draft" }));
    act(() => result.current.replaceLastAssistant({ role: "assistant", content: "final answer" }));
    expect(result.current.currentSession.messages[1]?.content).toBe("final answer");
  });

  it("appendToLastAssistant appends chunks to a single assistant message", () => {
    const { result } = renderHook(() => useGlobalChat());
    act(() => result.current.appendToLastAssistant("Hello"));
    act(() => result.current.appendToLastAssistant(" world"));
    expect(result.current.currentSession.messages).toHaveLength(1);
    expect(result.current.currentSession.messages[0]?.content).toBe("Hello world");
    expect(result.current.currentSession.messages[0]?.role).toBe("assistant");
  });

  it("appendToLastAssistant creates a new assistant msg if the last is user", () => {
    const { result } = renderHook(() => useGlobalChat());
    act(() => result.current.appendMessage({ role: "user", content: "hi" }));
    act(() => result.current.appendToLastAssistant("Hello"));
    expect(result.current.currentSession.messages).toHaveLength(2);
  });

  it("auto-title respects codepoints (emoji not split)", () => {
    const { result } = renderHook(() => useGlobalChat());
    // 33 emoji — should truncate to 32 + ellipsis without breaking a surrogate pair
    const msg = "🚀".repeat(33);
    act(() => result.current.appendMessage({ role: "user", content: msg }));
    expect(result.current.currentSession.title).toBe("🚀".repeat(32) + "…");
  });
});
