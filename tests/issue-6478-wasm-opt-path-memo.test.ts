// #6478 — the wasm-opt path resolution (a `which` spawn plus a `--version`
// spawn of binaryen's 10 MB bundled Node script) must happen once per process,
// not once per compile.
import { describe, it, expect, afterAll } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(`file://${process.cwd()}/`);
const cpMod = require_("node:child_process") as typeof import("node:child_process");
const realExecFileSync = cpMod.execFileSync;

const spawns: string[][] = [];
// Patch the CJS exports object — that is the exact object src/optimize.ts
// reaches through `createRequire`, so the ESM namespace would not do.
// Installed BEFORE importing optimize.ts, which caches the function reference.
(cpMod as { execFileSync: unknown }).execFileSync = function patched(this: unknown, ...args: unknown[]) {
  spawns.push([String(args[0]), ...((args[1] as string[] | undefined) ?? [])]);
  return (realExecFileSync as unknown as (...a: unknown[]) => unknown).apply(this, args);
};

afterAll(() => {
  (cpMod as { execFileSync: unknown }).execFileSync = realExecFileSync;
});

const hasBinaryen = (() => {
  try {
    require_.resolve("binaryen/package.json");
    return true;
  } catch {
    return false;
  }
})();

// An empty but valid WebAssembly module: magic + version.
const EMPTY_MODULE = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

describe("#6478 wasm-opt path probe memoisation", () => {
  it("probes --version once across repeated optimize calls", async () => {
    const { optimizeBinaryAsync } = await import("../src/optimize.js");

    // Force the binaryen-package fallback (the expensive branch) deterministically:
    // with no PATH, `which` itself cannot be spawned, so resolution falls through
    // to `binaryen/bin/wasm-opt` + its `--version` probe.
    const savedPath = process.env.PATH;
    process.env.PATH = "";
    try {
      spawns.length = 0;
      const first = await optimizeBinaryAsync(EMPTY_MODULE, { level: 1 });
      const second = await optimizeBinaryAsync(EMPTY_MODULE, { level: 1 });

      const versionProbes = spawns.filter((s) => s[1] === "--version");
      // Exactly one when the binaryen package is installed (the probed
      // candidate); zero only if the package is missing entirely, in which
      // case there is nothing to memoise.
      expect(versionProbes.length).toBe(hasBinaryen ? 1 : 0);

      // And the memo must not change what is produced.
      expect(second.optimized).toBe(first.optimized);
      expect(Array.from(second.binary)).toEqual(Array.from(first.binary));
    } finally {
      process.env.PATH = savedPath;
    }
  });
});
