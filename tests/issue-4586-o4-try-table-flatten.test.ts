// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";

const runner = `
import { compile } from ${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)};

const source = String.raw\`
/** @param {*} value */
export function guarded(value) {
  try {
    if (value) throw value;
    return 1;
  } catch (error) {
    return error ? 2 : 3;
  }
}
\`;

const raw = await compile(source, {
  allowJs: true,
  fileName: "issue-4586.mjs",
  target: "standalone",
  emitWat: true,
});
const optimized = await compile(source, {
  allowJs: true,
  fileName: "issue-4586.mjs",
  target: "standalone",
  optimize: 4,
});
const { instance } = await WebAssembly.instantiate(optimized.binary, {});
const guarded = instance.exports.guarded;

process.stdout.write(JSON.stringify({
  rawSuccess: raw.success,
  rawBytes: raw.binary.length,
  hasTryTable: raw.wat.includes("try_table"),
  optimizedSuccess: optimized.success,
  optimizedBytes: optimized.binary.length,
  diagnostics: optimized.errors.map((error) => error.message),
  normalResult: guarded(null),
  caughtResult: guarded(42),
}));
`;

describe("#4586 — Binaryen O4 standardized-EH fallback", () => {
  test("retries without only Flatten and returns optimized runnable try_table output", () => {
    const child = spawnSync(
      process.execPath,
      ["--experimental-wasm-exnref", "--import", "tsx", "--input-type=module", "--eval", runner],
      { cwd: process.cwd(), encoding: "utf8", timeout: 60_000 },
    );

    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout) as {
      rawSuccess: boolean;
      rawBytes: number;
      hasTryTable: boolean;
      optimizedSuccess: boolean;
      optimizedBytes: number;
      diagnostics: string[];
      normalResult: number;
      caughtResult: number;
    };
    expect(result.rawSuccess).toBe(true);
    expect(result.hasTryTable).toBe(true);
    expect(result.optimizedSuccess).toBe(true);
    expect(result.optimizedBytes).toBeLessThan(result.rawBytes);
    expect(result.diagnostics).toContain(
      "wasm-opt -O4 omitted Binaryen's unsupported flatten pass for standardized try_table output; all remaining O4 passes completed.",
    );
    expect(result.diagnostics.join("\n")).not.toContain("shipping UNOPTIMIZED");
    expect(result.normalResult).toBe(1);
    expect(result.caughtResult).toBe(2);
  });
});
