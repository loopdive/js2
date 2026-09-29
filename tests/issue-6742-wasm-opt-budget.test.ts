// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6742 / #6732 — the npm-compat standalone lanes pick a wasm-opt level the
// module's size and the lane budget can afford, step down on failure, and
// record the level that produced the measured artifact. The optimizer names a
// timeout and keeps the #4586 retry's own failure readable.

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { optimizeBinaryAsync } from "../src/optimize.ts";
import {
  optimizationReceiptHolds,
  optimizeStandaloneLaneBinary,
  planStandaloneOptimization,
  STANDALONE_OPT_SIZE_CEILINGS,
} from "../scripts/lib/npm-compat-opt-budget.mjs";
import { O4_TRY_TABLE_FLATTEN_OMISSION } from "../scripts/lib/npm-compat-perf.mjs";

const TRY_TABLE_SOURCE = `
/** @param {*} value */
export function guarded(value) {
  try {
    if (value) throw value;
    return 1;
  } catch (error) {
    return error ? 2 : 3;
  }
}
`;

async function withFakeWasmOpt<T>(script: string, run: () => Promise<T>): Promise<T> {
  const fakeRoot = mkdtempSync(join(tmpdir(), "js2-wasm-opt-6742-"));
  const fakeWasmOpt = join(fakeRoot, "wasm-opt");
  writeFileSync(
    fakeWasmOpt,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--help")) { console.log("--disable-compact-imports"); process.exit(0); }
${script}
`,
  );
  chmodSync(fakeWasmOpt, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = [fakeRoot, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter);
  try {
    return await run();
  } finally {
    if (previousPath === undefined) Reflect.deleteProperty(process.env, "PATH");
    else process.env.PATH = previousPath;
    rmSync(fakeRoot, { recursive: true, force: true });
  }
}

describe("#6732 — optimizer failure text", () => {
  it("names a timeout at the caller's timeoutMs instead of an opaque failure", async () => {
    const raw = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
    const result = await withFakeWasmOpt(
      `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8000);
fs.copyFileSync(args[0], args[args.indexOf("-o") + 1]);`,
      () => optimizeBinaryAsync(raw, { level: 2, timeoutMs: 1500 }),
    );
    expect(result.optimized).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.warning).toBe("wasm-opt -O2 failed: wasm-opt timed out after 1500 ms");
    expect(result.binary).toEqual(raw);
  }, 30_000);

  it("keeps the #4586 retry's own failure ahead of Binaryen.js's source dump", async () => {
    const raw = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
    const result = await withFakeWasmOpt(
      `if (args.includes("--skip-pass=flatten")) {
  process.stderr.write("[wasm-validator error in function 7] retry-specific failure\\n");
  process.exit(1);
}
process.stderr.write("unexpected expr type\\nUNREACHABLE executed at /x/binaryen/src/passes/Flatten.cpp:231!\\nAborted()\\n");
process.stderr.write("/opt/binaryen/bin/wasm-opt:2\\n" + "var Module=" + "x".repeat(3000) + "\\n" + " ".repeat(1000) + "^\\n");
process.stderr.write("RuntimeError: Aborted()\\n    at abort (/opt/binaryen/bin/wasm-opt:2:3328)\\n");
process.exit(1);`,
      () => optimizeBinaryAsync(raw, { level: 4 }),
    );
    expect(result.optimized).toBe(false);
    expect(result.warning).toMatch(/^wasm-opt -O4 failed: retry without flatten failed: .*retry-specific failure/);
    expect(result.warning).toContain("Flatten.cpp:231");
    expect(result.warning).not.toContain("var Module=");
    expect(result.warning).not.toContain("    at abort");
  });
});

describe("#6742 — budget-aware standalone optimization level", () => {
  it("plans from the raw size: O4, then O2, then O1", () => {
    expect(planStandaloneOptimization(1_198_739, 4)).toEqual({ level: 4, reason: "requested" });
    expect(planStandaloneOptimization(5_822_763, 4).level).toBe(4);
    const axios = planStandaloneOptimization(9_260_766, 4);
    expect(axios.level).toBe(2);
    expect(axios.reason).toBe(
      `raw module 9260766 B exceeds the -O4 size ceiling (${STANDALONE_OPT_SIZE_CEILINGS[0].maxRawBytes} B)`,
    );
    expect(planStandaloneOptimization(40_000_000, 4).level).toBe(1);
  });

  const raw = new Uint8Array(1000);
  const out = new Uint8Array(10);

  it("steps down 4 → 2 on a timeout and records every attempt", async () => {
    const calls: { level: number; timeoutMs: number }[] = [];
    const { binary, metadata } = await optimizeStandaloneLaneBinary(raw, {
      requestedLevel: 4,
      optimize: async (_binary: Uint8Array, options: { level: number; timeoutMs: number }) => {
        calls.push({ level: options.level, timeoutMs: options.timeoutMs });
        return options.level === 4
          ? { binary: raw, optimized: false, timedOut: true, warning: "wasm-opt -O4 failed: wasm-opt timed out" }
          : { binary: out, optimized: true };
      },
    });
    expect(calls.map((call) => call.level)).toEqual([4, 2]);
    expect(binary).toBe(out);
    expect(metadata).toMatchObject({
      optimizationRequested: true,
      optimizationVerified: true,
      optimizationLevel: 2,
      optimizationLevelRequested: 4,
      optimizationLevelReason: "-O4 timed out",
      rawBinaryBytes: 1000,
    });
    expect(metadata.optimizationAttempts.map((a: { outcome: string }) => a.outcome)).toEqual(["timeout", "optimized"]);
  });

  it("accepts only the #4586 Flatten omission as an O4 success", async () => {
    const { metadata } = await optimizeStandaloneLaneBinary(raw, {
      requestedLevel: 4,
      optimize: async () => ({ binary: out, optimized: true, warning: O4_TRY_TABLE_FLATTEN_OMISSION }),
    });
    expect(metadata.optimizationLevel).toBe(4);
    expect(metadata.optimizationOmittedPasses).toEqual(["flatten"]);
    expect(metadata).not.toHaveProperty("optimizationLevelReason");
  });

  it("measures the raw module as level 0, unverified, when every rung fails", async () => {
    const { binary, metadata } = await optimizeStandaloneLaneBinary(raw, {
      requestedLevel: 4,
      optimize: async (_binary: Uint8Array, options: { level: number }) => ({
        binary: raw,
        optimized: false,
        warning: `wasm-opt -O${options.level} failed: boom`,
      }),
    });
    expect(binary).toBe(raw);
    expect(metadata).toMatchObject({
      optimizationVerified: false,
      optimizationLevel: 0,
      optimizationLevelReason: "-O1 failed",
    });
    expect(metadata.optimizationAttempts.map((a: { level: number }) => a.level)).toEqual([4, 2, 1]);
  });

  it("splits a lane deadline so the last rung keeps time, and skips when none is left", async () => {
    let clock = 0;
    const timeouts: number[] = [];
    const { metadata } = await optimizeStandaloneLaneBinary(raw, {
      requestedLevel: 4,
      deadline: 100_000,
      now: () => clock,
      optimize: async (_binary: Uint8Array, options: { level: number; timeoutMs: number }) => {
        timeouts.push(options.timeoutMs);
        clock += options.timeoutMs;
        return { binary: raw, optimized: false, timedOut: true, warning: "timed out" };
      },
    });
    // 60 % of 100 s, 60 % of the 40 s left, then all of the final 16 s.
    expect(timeouts).toEqual([60_000, 24_000, 16_000]);
    expect(metadata.optimizationLevel).toBe(0);

    const exhausted = await optimizeStandaloneLaneBinary(raw, {
      requestedLevel: 4,
      deadline: 1_000,
      now: () => 0,
      optimize: async () => {
        throw new Error("must not run");
      },
    });
    expect(exhausted.metadata.optimizationLevel).toBe(0);
    expect(exhausted.metadata.optimizationAttempts.map((a: { outcome: string }) => a.outcome)).toEqual([
      "skipped",
      "skipped",
      "skipped",
    ]);
  });

  it("skips a rung whose measured cost floor cannot fit the time left (lodash-es in a 120 s child)", async () => {
    const lodashRaw = new Uint8Array(5_822_763);
    const levels: number[] = [];
    const { metadata } = await optimizeStandaloneLaneBinary(lodashRaw, {
      requestedLevel: 4,
      deadline: 90_000,
      now: () => 50_000,
      optimize: async (_binary: Uint8Array, options: { level: number }) => {
        levels.push(options.level);
        return { binary: out, optimized: true };
      },
    });
    // 40 s left: O4 (≥145 s) and O2 (≥87 s) cannot fit; O1 (≥35 s) gets all 40 s.
    expect(levels).toEqual([1]);
    expect(metadata.optimizationLevel).toBe(1);
    expect(metadata.optimizationAttempts[0]).toEqual({
      level: 4,
      outcome: "skipped",
      detail: "needs at least 145569 ms, 24000 ms available",
    });
  });

  it("accepts a lowered level in the report receipt only when its last attempt produced it", () => {
    const base = { optimizationRequested: true, optimizationLevelRequested: 4 };
    const o2 = { level: 2, outcome: "optimized", durationMs: 1 };
    expect(
      optimizationReceiptHolds({ optimizationRequested: true, optimizationVerified: true, optimizationLevel: 4 }, 4),
    ).toBe(true);
    expect(
      optimizationReceiptHolds({ optimizationRequested: true, optimizationVerified: true, optimizationLevel: 2 }, 4),
    ).toBe(false);
    expect(
      optimizationReceiptHolds(
        { ...base, optimizationVerified: true, optimizationLevel: 2, optimizationAttempts: [o2] },
        4,
      ),
    ).toBe(true);
    expect(
      optimizationReceiptHolds(
        { ...base, optimizationVerified: true, optimizationLevel: 4, optimizationAttempts: [o2] },
        4,
      ),
    ).toBe(false);
    expect(
      optimizationReceiptHolds(
        { ...base, optimizationVerified: false, optimizationLevel: 0, optimizationAttempts: [] },
        4,
      ),
    ).toBe(true);
    expect(
      optimizationReceiptHolds(
        { ...base, optimizationVerified: true, optimizationLevel: 0, optimizationAttempts: [] },
        4,
      ),
    ).toBe(false);
  });

  it("optimizes a real try_table module at O4 (Flatten omitted) and at a budget-lowered O2", async () => {
    const compiled = await compile(TRY_TABLE_SOURCE, {
      allowJs: true,
      fileName: "issue-6742.mjs",
      target: "standalone",
    });
    expect(compiled.success).toBe(true);
    const run = async (binary: Uint8Array) => {
      const { instance } = await WebAssembly.instantiate(binary, {});
      const guarded = instance.exports.guarded as (value: unknown) => number;
      return [guarded(null), guarded(42)];
    };

    const o4 = await optimizeStandaloneLaneBinary(compiled.binary, {
      requestedLevel: 4,
      optimize: optimizeBinaryAsync,
    });
    expect(o4.metadata.optimizationLevel).toBe(4);
    expect(o4.metadata.optimizationOmittedPasses).toEqual(["flatten"]);
    expect(o4.binary.length).toBeLessThan(compiled.binary.length);
    expect(await run(o4.binary)).toEqual([1, 2]);

    const o2 = await optimizeStandaloneLaneBinary(compiled.binary, {
      requestedLevel: 4,
      optimize: optimizeBinaryAsync,
      ceilings: [
        { level: 4, maxRawBytes: 1_000 },
        { level: 2, maxRawBytes: Number.POSITIVE_INFINITY },
      ],
    });
    expect(o2.metadata.optimizationLevel).toBe(2);
    expect(o2.metadata.optimizationLevelReason).toBe(
      `raw module ${compiled.binary.length} B exceeds the -O4 size ceiling (1000 B)`,
    );
    expect(o2.metadata.optimizationAttempts).toHaveLength(1);
    expect(await run(o2.binary)).toEqual([1, 2]);
  }, 300_000);
});
