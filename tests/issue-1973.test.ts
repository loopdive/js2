// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1973 — `optimize` via the binaryen npm module re-introduced exact heap types.
//
// binaryen 125's `Features.All` (0x3FFFFF) includes an *unnamed* custom-
// descriptors bit (0x200000) that its JS Features enum does not expose as a
// key, so the `CustomDescriptors !== undefined` guard in optimize.ts silently
// no-opped and `mod.optimize()` could rewrite `(ref $T)` → `(ref (exact $T))` —
// a type stock V8/JSC reject ("invalid heap type 'exact'") and wasmtime ≤ 44
// can't parse. optimize.ts now builds the feature mask by OR-ing only the NAMED
// enum keys, so the unnamed bit is never set.
//
// Two properties (mirroring the issue's acceptance criteria):
//   1. `optimize: 3` output validates (V8 acceptance) and contains no `exact`
//      reference types, for closures/arrays/classes.
//   2. Optimized output produces identical observable results to unoptimized.

import { describe, expect, it } from "vitest";
import binaryen from "binaryen";
import { compile } from "../src/index.js";
import { buildImports } from "./equivalence/helpers.js";

/** Does the (re-parsed) optimized binary contain any `exact` heap type? */
function hasExactRefTypes(binary: Uint8Array): boolean {
  const mod = binaryen.readBinary(binary);
  try {
    return /\bexact\b/.test(mod.emitText());
  } finally {
    mod.dispose();
  }
}

const PROGRAMS: Array<[string, string]> = [
  // The exact issue repro — a closure that mutates a captured local in a loop.
  [
    "closure",
    `export function main(): void {
       let acc = 0; const add = (x: number) => { acc += x; };
       for (let i = 0; i < 5; i++) add(i);
       console.log(acc);
     }`,
  ],
  [
    "array",
    `export function main(): void { const a = [1, 2, 3, 4]; let s = 0; for (const x of a) s += x; console.log(s); }`,
  ],
  [
    "class",
    `class P { x: number; constructor(x: number) { this.x = x; } g(): number { return this.x * 2; } }
     export function main(): void { console.log(new P(7).g()); }`,
  ],
];

async function runProgram(source: string, optimize: boolean): Promise<string[]> {
  const result = await compile(source, optimize ? { optimize: 3 } : {});
  expect(result.success, `compile failed: ${result.errors.map((e) => e.message).join("; ")}`).toBe(true);

  if (optimize) {
    // Property 1: must validate on a stock engine, and carry no exact types.
    expect(WebAssembly.validate(result.binary), "optimized binary failed WebAssembly.validate").toBe(true);
    expect(hasExactRefTypes(result.binary), "optimized binary contains exact ref types (#1973)").toBe(false);
  }

  const output: string[] = [];
  const imports = buildImports(result);
  const env = imports.env as Record<string, (...a: unknown[]) => unknown>;
  env.console_log_number = (v: unknown) => void output.push(String(v));
  env.console_log_string = (v: unknown) => void output.push(String(v));
  env.console_log_bool = (v: unknown) => void output.push(String(!!v));
  env.console_log_externref = (v: unknown) => void output.push(String(v));

  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const main = (instance.exports as Record<string, unknown>).main;
  if (typeof main === "function") (main as () => void)();
  return output;
}

describe("#1973 optimize output has no exact heap types and round-trips", () => {
  for (const [label, source] of PROGRAMS) {
    it(`${label}: optimized binary validates, no exact types, matches unoptimized`, async () => {
      const unopt = await runProgram(source, false);
      const opt = await runProgram(source, true);
      expect(opt).toEqual(unopt);
    });
  }
});
