import type { BuildEvent } from "./types";

type Sub = (seq: number, e: BuildEvent) => void;

/** Ordered in-process pub/sub. Synchronous fan-out; a throwing subscriber is
 *  isolated so it can't break the build or other subscribers. */
export class Bus {
  private subs: Sub[] = [];
  private seq = 0;
  subscribe(fn: Sub): () => void {
    this.subs.push(fn);
    return () => { this.subs = this.subs.filter((s) => s !== fn); };
  }
  emit(e: BuildEvent): void {
    const seq = this.seq++;
    for (const s of this.subs) {
      try { s(seq, e); } catch { /* isolate subscriber failures */ }
    }
  }
}
