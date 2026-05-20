/**
 * #1521 — Unit tests for `matchesPathFilter` (path-scoped test selection
 * used by the Test262 Differential workflow). The function memoizes the
 * env var on first call, so we use `vi.resetModules` per test to bypass
 * the cache.
 */
import { describe, it, expect, afterEach, vi } from "vitest";

const ENV_VAR = "TEST262_PATH_FILTER";

async function freshMatcher(): Promise<(p: string) => boolean> {
  vi.resetModules();
  const mod = await import("./test262-runner.js");
  return mod.matchesPathFilter as (p: string) => boolean;
}

describe("#1521 matchesPathFilter", () => {
  let originalFilter: string | undefined;

  afterEach(() => {
    if (originalFilter === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = originalFilter;
  });

  it("matches everything when filter is unset", async () => {
    originalFilter = process.env[ENV_VAR];
    delete process.env[ENV_VAR];
    const match = await freshMatcher();
    expect(match("built-ins/RegExp/prototype/test/foo.js")).toBe(true);
    expect(match("language/expressions/addition/bar.js")).toBe(true);
  });

  it("matches everything when filter is empty string", async () => {
    originalFilter = process.env[ENV_VAR];
    process.env[ENV_VAR] = "";
    const match = await freshMatcher();
    expect(match("built-ins/RegExp/prototype/test/foo.js")).toBe(true);
  });

  it("filters by single substring pattern", async () => {
    originalFilter = process.env[ENV_VAR];
    process.env[ENV_VAR] = "built-ins/RegExp";
    const match = await freshMatcher();
    expect(match("built-ins/RegExp/prototype/test/foo.js")).toBe(true);
    expect(match("language/expressions/addition/bar.js")).toBe(false);
  });

  it("filters by multiple pipe-separated patterns", async () => {
    originalFilter = process.env[ENV_VAR];
    process.env[ENV_VAR] = "built-ins/RegExp|built-ins/String";
    const match = await freshMatcher();
    expect(match("built-ins/RegExp/prototype/test/foo.js")).toBe(true);
    expect(match("built-ins/String/prototype/split.js")).toBe(true);
    expect(match("built-ins/Array/prototype/map.js")).toBe(false);
    expect(match("language/class/heritage.js")).toBe(false);
  });

  it("ignores empty pipe-separated segments", async () => {
    originalFilter = process.env[ENV_VAR];
    process.env[ENV_VAR] = "||built-ins/RegExp||";
    const match = await freshMatcher();
    expect(match("built-ins/RegExp/prototype/test/foo.js")).toBe(true);
    expect(match("language/expressions/addition/bar.js")).toBe(false);
  });
});
