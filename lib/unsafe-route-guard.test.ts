import { afterEach, describe, expect, it, vi } from "vitest";
import { blockUnsafeDevRouteInProduction } from "./unsafe-route-guard";

describe("blockUnsafeDevRouteInProduction", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows dev/test routes outside production", () => {
    vi.stubEnv("NODE_ENV", "development");

    expect(blockUnsafeDevRouteInProduction("/api/test/example")).toBeNull();
  });

  it("blocks dev/test routes in production by default", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const res = blockUnsafeDevRouteInProduction("/api/test/example");

    expect(res?.status).toBe(404);
    await expect(res?.json()).resolves.toMatchObject({ error: "NOT_FOUND" });
  });

  it("allows explicit staging escape hatch", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AO_ENABLE_UNSAFE_DEV_ROUTES", "1");

    expect(blockUnsafeDevRouteInProduction("/api/test/example")).toBeNull();
  });
});
