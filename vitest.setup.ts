// Test environment shims.
//
// Node 26 ships a NATIVE experimental `globalThis.localStorage` that is unavailable unless the
// process is started with `--localstorage-file`, and under it happy-dom's `window.localStorage`
// comes back `undefined`. Tests that persist UI state (lib/chat/use-global-chat, etc.) then throw
// `Cannot read properties of undefined (reading 'clear')`. Provide a simple in-memory Storage so the
// suite runs clean on Node 26 — and ONLY when the environment's localStorage is missing/broken, so
// Node 22 (where happy-dom's own works) is untouched.

class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  get length(): number { return this.m.size; }
  clear(): void { this.m.clear(); }
  getItem(key: string): string | null { return this.m.has(key) ? (this.m.get(key) as string) : null; }
  setItem(key: string, value: string): void { this.m.set(key, String(value)); }
  removeItem(key: string): void { this.m.delete(key); }
  key(index: number): string | null { return [...this.m.keys()][index] ?? null; }
}

function ensureStorage(target: Record<string, unknown> | undefined, prop: "localStorage" | "sessionStorage", store: Storage): void {
  if (!target) return;
  const cur = target[prop] as Storage | undefined;
  if (cur && typeof cur.clear === "function") return; // a working Storage already exists → leave it
  try {
    Object.defineProperty(target, prop, { value: store, configurable: true, writable: true });
  } catch {
    target[prop] = store;
  }
}

const g = globalThis as unknown as Record<string, unknown>;
ensureStorage(g, "localStorage", new MemoryStorage());
ensureStorage(g, "sessionStorage", new MemoryStorage());
if (typeof g.window !== "undefined") {
  const w = g.window as Record<string, unknown>;
  // mirror the SAME instances onto window so `window.localStorage` and bare `localStorage` agree.
  ensureStorage(w, "localStorage", g.localStorage as Storage);
  ensureStorage(w, "sessionStorage", g.sessionStorage as Storage);
}
