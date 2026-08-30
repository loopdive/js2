// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4406 Phase 4) The return-unboxing ABI is DEFAULT-ON, and the
 * `numericFunctions` verdict no longer claims boolean-returning names.
 *
 * Phases 0–3 shipped behind `JS2WASM_RET_UNBOX_ABI` (opt-in). Phase 4 flips the
 * default, and the reason is correctness, not perf: with the flag off,
 * `refinedTwinReturnType` reaches its numeric arm for a predicate method —
 * `Prover.isNumeric` answers true for booleans by design — and mints an `f64`
 * twin, so a predicate's result stringifies as `"1"` / `"0"` instead of
 * `"true"` / `"false"`.
 *
 * Non-vacuity: every `default` expectation in the first two blocks below is
 * pinned against its own `JS2WASM_RET_UNBOX_ABI=0` twin IN THE SAME TEST, so a
 * build where the flag silently reverted to opt-in fails here rather than
 * passing quietly. Measured on `origin/main` @ `f727d529ab` before this change,
 * all five witnesses answered the OFF value by default.
 */
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const PREDICATE_PRELUDE = `
function P(n) { this.n = n; this.tag = "v="; }
var pp = P.prototype;
pp.eq   = function (x) { return this.n === x; };
pp.pred = function (x) { return this.eq(x) && this.eq(x); };
`;

async function run(source: string, env: Record<string, string> = {}): Promise<unknown> {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(env)) {
    saved.set(k, process.env[k]);
    process.env[k] = v;
  }
  try {
    const result = await compile(source, {
      fileName: "probe.mjs",
      skipSemanticDiagnostics: true,
      target: "standalone",
      optimize: 0,
    });
    expect(result.binary?.length ?? 0).toBeGreaterThan(0);
    const { exports } = await WebAssembly.instantiate(await WebAssembly.compile(result.binary!), {});
    return (exports as Record<string, () => unknown>).probe!();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const OFF = { JS2WASM_RET_UNBOX_ABI: "0" };

describe("#4406 Phase 4 — the boolean-return ABI is on by default", () => {
  it("stringifies a predicate result as `true`, not `1`", async () => {
    // `pred`'s returns are `&&` of CALLS, so the syntactic `isBooleanish` test
    // cannot follow them — only #2847's name-keyed fixpoint proves it boolean.
    const src = `${PREDICATE_PRELUDE}
export function probe() { var p = new P(5); return ("" + p.pred(5)).length; }`;
    expect(await run(src)).toBe(4); // "true"
    expect(await run(src, OFF)).toBe(1); // "1" — the defect the default used to ship
  }, 60_000);

  it("stringifies a false predicate result as `false`, not `0`", async () => {
    const src = `${PREDICATE_PRELUDE}
export function probe() { var p = new P(5); return ("" + p.pred(7)).length; }`;
    expect(await run(src)).toBe(5); // "false"
    expect(await run(src, OFF)).toBe(1); // "0"
  }, 60_000);

  it("reports `typeof` a predicate result as boolean, not number", async () => {
    const src = `${PREDICATE_PRELUDE}
export function probe() { var p = new P(5); return typeof p.pred(5) === "boolean" ? 1 : 0; }`;
    expect(await run(src)).toBe(1);
    expect(await run(src, OFF)).toBe(0);
  }, 60_000);
});

describe("#4406 Phase 4 — the numericFunctions admission filter", () => {
  it("stops `provenNumericOperand` claiming a predicate call as an f64 operand", async () => {
    // The SECOND consumer of `numericFunctionNames` (binary-ops.ts), which the
    // flag's boolean arm cannot reach: it rewrites `this.tag + this.eq(x)` as
    // f64 arithmetic, so the concatenation yields NaN and `.length` reads 0.
    // Isolated on base by lane sweep: only `JS2WASM_NUMERIC_OPERANDS=0` fixed
    // it — neither `JS2WASM_NUMERIC_TWINS=0` nor `JS2WASM_DIRECT_CALLS=0` did.
    const src = `${PREDICATE_PRELUDE}
pp.show = function (x) { return this.tag + this.eq(x); };
export function probe() { var p = new P(5); return p.show(5).length; }`;
    expect(await run(src)).toBe(6); // "v=true"
    expect(await run(src, OFF)).toBe(0); // NaN.length
  }, 60_000);

  it("keeps a genuinely numeric method's operand fast path", async () => {
    // The filter withdraws BOOLEAN names only. A numeric method must keep its
    // f64 verdict, or the fix would be a blanket disable of the mechanism.
    const src = `
function P(n) { this.n = n; this.tag = "v="; }
var pp = P.prototype;
pp.num  = function (x) { return this.n + x; };
pp.show = function (x) { return this.tag + this.num(x); };
export function probe() { var p = new P(5); return p.show(5).length; }`;
    expect(await run(src)).toBe(4); // "v=10"
    expect(await run(src, OFF)).toBe(4);
  }, 60_000);
});

describe("#4406 Phase 4 — the off-token contract survives the default flip", () => {
  it("treats every off-token as OFF and any other value as the new default", async () => {
    const src = `${PREDICATE_PRELUDE}
export function probe() { var p = new P(5); return ("" + p.pred(5)).length; }`;
    for (const token of ["0", "off", "false", "no", ""]) {
      expect(await run(src, { JS2WASM_RET_UNBOX_ABI: token })).toBe(1);
    }
    // A typo must not silently half-disable the mechanism — the family's rule.
    expect(await run(src, { JS2WASM_RET_UNBOX_ABI: "yes" })).toBe(4);
  }, 300_000);
});
