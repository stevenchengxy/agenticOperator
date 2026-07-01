// P1-3: the live-write gate is fail-closed. With LIVE_WRITE_DOMAINS unset (default),
// NO domain is allowed real writes — every write/dual-write tool degrades to dry-run.
// Dry-run/sandbox domains are mock regardless.

import { describe, it, expect } from "vitest";
import { isLiveWriteAllowed } from "./resolve-registry";

describe("isLiveWriteAllowed — fail-closed write gate", () => {
  it("dry-run / force-dryrun domains are never live-write (always mock)", () => {
    expect(isLiveWriteAllowed("agents-generation")).toBe(false);
    expect(isLiveWriteAllowed("Agents-generation")).toBe(false); // case-insensitive
    expect(isLiveWriteAllowed("sandbox-招聘-v1")).toBe(false);
  });

  it("an unknown live domain is NOT allowed by default (fail-closed, empty allowlist)", () => {
    expect(isLiveWriteAllowed("some-live-domain")).toBe(false);
    expect(isLiveWriteAllowed("招聘-v1")).toBe(false); // not in LIVE_WRITE_DOMAINS → degraded
  });
});
