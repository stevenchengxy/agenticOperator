"use client";
import { useCallback, useEffect, useState } from "react";
import type { ChatMessage } from "./types";

export type ChatSession = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
};

const STORAGE_KEY = "ao:global-chat:v1";

type Persisted = {
  current: ChatSession;
  sessions: ChatSession[];
};

function emptySession(): ChatSession {
  const now = new Date().toISOString();
  return { id: cryptoRandom(), title: "新会话", createdAt: now, updatedAt: now, messages: [] };
}

function cryptoRandom(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return Math.random().toString(36).slice(2, 10);
}

function load(): Persisted {
  if (typeof window === "undefined") return { current: emptySession(), sessions: [] };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { current: emptySession(), sessions: [] };
    const parsed = JSON.parse(raw) as Persisted;
    if (!parsed.current || !Array.isArray(parsed.sessions)) throw new Error("bad");
    return parsed;
  } catch {
    return { current: emptySession(), sessions: [] };
  }
}

function save(state: Persisted): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage full or disabled — silently skip
  }
}

function autoTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return "新会话";
  // Spread iterates Unicode codepoints (handles surrogate pairs / emoji correctly).
  const chars = [...firstUser.content];
  return chars.slice(0, 32).join("") + (chars.length > 32 ? "…" : "");
}

export function useGlobalChat() {
  const [state, setState] = useState<Persisted>(() => load());

  useEffect(() => {
    save(state);
  }, [state]);

  const appendMessage = useCallback((m: ChatMessage) => {
    setState((s) => {
      const messages = [...s.current.messages, m];
      const title =
        s.current.messages.length === 0 && m.role === "user"
          ? autoTitle(messages)
          : s.current.title;
      return {
        ...s,
        current: { ...s.current, messages, title, updatedAt: new Date().toISOString() },
      };
    });
  }, []);

  const replaceLastAssistant = useCallback((m: ChatMessage) => {
    setState((s) => {
      const msgs = [...s.current.messages];
      const reversedIdx = [...msgs].reverse().findIndex((mm) => mm.role === "assistant");
      if (reversedIdx >= 0) {
        msgs[msgs.length - 1 - reversedIdx] = m;
      } else {
        msgs.push(m);
      }
      return { ...s, current: { ...s.current, messages: msgs, updatedAt: new Date().toISOString() } };
    });
  }, []);

  const clearCurrent = useCallback(() => {
    setState((s) => ({ ...s, current: emptySession() }));
  }, []);

  const newSession = useCallback(() => {
    setState((s) => {
      // Archive current only if it has messages
      const archive =
        s.current.messages.length > 0 ? [s.current, ...s.sessions] : s.sessions;
      return { current: emptySession(), sessions: archive };
    });
  }, []);

  const switchSession = useCallback((id: string) => {
    setState((s) => {
      const found = s.sessions.find((x) => x.id === id);
      if (!found) return s;
      const archive =
        s.current.messages.length > 0 && s.current.id !== id
          ? [s.current, ...s.sessions.filter((x) => x.id !== id)]
          : s.sessions.filter((x) => x.id !== id);
      return { current: found, sessions: archive };
    });
  }, []);

  const deleteSession = useCallback((id: string) => {
    setState((s) => ({ ...s, sessions: s.sessions.filter((x) => x.id !== id) }));
  }, []);

  const renameSession = useCallback((id: string, title: string) => {
    setState((s) => ({
      ...s,
      current: s.current.id === id ? { ...s.current, title } : s.current,
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, title } : x)),
    }));
  }, []);

  return {
    currentSession: state.current,
    sessions: state.sessions,
    appendMessage,
    replaceLastAssistant,
    clearCurrent,
    newSession,
    switchSession,
    deleteSession,
    renameSession,
  };
}
