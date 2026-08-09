// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3551 — IR ABI-parity withdrawal must CASCADE to committed IR callers.
//
// Every IR body is compiled against `calleeTypes` — the IR's shared view of
// each claimed function's signature. #3503 (the #3536 fix) taught the
// patch-time typeIdx-parity guard to WITHDRAW a top-level function whose
// IR-resolved signature diverges from the legacy-registered one (keeping the
// legacy body + ABI). But withdrawal was per-function: a caller whose own
// typeIdx matched still COMMITTED its IR body — a body whose call arguments
// were baked against the withdrawn callee's IR-view signature, which the
// parity mismatch just proved is NOT the callee's final ABI.
//
// Concrete regression (tests/issue-3471.test.ts, "numeric args to isSameValue
// still compare correctly"): the IR TypeMap propagated f64 through
// `check(1, 1) → isSameValue(a, b)` and typed `isSameValue` as `(f64, f64)`,
// while legacy inference (post-#3471) kept its polymorphic params boxed as
// `(externref, externref)`. `isSameValue` withdrew on the mismatch (legacy
// externref ABI kept); `check` committed an IR body passing raw f64s. The
// stack-balance repair then mangled the args (double-boxed arg 0, raw-f64
// arg 1) and instantiation failed:
//   "Compiling function "check" failed: call[0] expected type f64, found
//    call of type externref"
//
// Fix: collect every parity-withdrawn name; before applying patches, withdraw
// any still-pending patch whose IR body references one of them (`call` target
// or `closure.new` lifted-func ref). One level is a fixpoint: a
// cascade-withdrawn caller passed the guard itself, so its legacy body keeps
// the exact ABI its own callers compiled against.

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { describe, expect, it } from "vitest";

/** Compile in host mode, instantiate, and return the exported `test()` value. */
async function runTest(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "t.ts" });
  expect(r.success, r.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const imports = buildImports(r.imports, {}, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports as WebAssembly.Imports);
  const exports = instance.exports as Record<string, (...a: unknown[]) => unknown>;
  if ((imports as { setExports?: (e: unknown) => void }).setExports) {
    (imports as { setExports: (e: unknown) => void }).setExports(exports);
  }
  return exports.test();
}

// The exact divergence shape: `poly`'s params stay boxed under legacy
// inference (polymorphic — post-#3471), while the IR TypeMap propagates the
// numeric call-site types and re-types them f64 → parity withdrawal.
const POLY = `
function poly(a, b) {
  if (a === 0 && b === 0) return 1 / a === 1 / b;
  if (a !== a && b !== b) return true;
  return a === b;
}`;

describe("#3551 — parity withdrawal cascades to committed IR callers", () => {
  it("caller of a parity-withdrawn callee instantiates and runs (the #3503 regression shape)", async () => {
    const src = `${POLY}
      function mid(a, b) { return poly(a, b); }
      export function test() {
        var eq = mid(1, 1) ? 1 : 0;    // 1
        var ne = mid(1, 2) ? 10 : 0;   // 0
        return eq + ne;                // expect 1
      }`;
    // Pre-fix: WebAssembly.instantiate CompileError ("call[0] expected type
    // f64, found call of type externref") — `mid` committed its IR body
    // (raw-f64 call per the IR view) while `poly` withdrew to its legacy
    // (externref, externref) ABI.
    expect(await runTest(src)).toBe(1);
  });

  it("cascade withdrawal surfaces on the IR fallback channel, not as an invalid module", async () => {
    const src = `${POLY}
      function mid(a, b) { return poly(a, b); }
      export function test() { return mid(2, 2) ? 1 : 0; }`;
    const r = await compile(src, { fileName: "t.ts" });
    expect(r.success).toBe(true);
    const warnings = r.errors.map((e) => e.message).join("\n");
    // The callee withdraws on the parity mismatch...
    expect(warnings).toMatch(/poly: function typeIdx parity mismatch/);
    // ...and the caller is withdrawn BY THE CASCADE (references the callee),
    // rather than committing a body baked against the dead IR-view ABI.
    expect(warnings).toMatch(/mid: body references poly, whose claim was withdrawn on a typeIdx parity mismatch/);
  });

  it("a two-level chain through the withdrawn callee still computes correct values", async () => {
    const src = `${POLY}
      function mid(a, b) { return poly(a, b); }
      function outer(a, b) { return mid(a, b); }
      export function test() {
        var eq = outer(3, 3) ? 1 : 0;   // 1
        var ne = outer(3, 4) ? 10 : 0;  // 0
        return eq + ne;                 // expect 1
      }`;
    // `mid` is cascade-withdrawn; `outer`'s ABI expectation of `mid` is
    // unchanged (mid passed the guard — legacy typeIdx === IR typeIdx), so
    // one cascade level suffices whether `outer` commits or not.
    expect(await runTest(src)).toBe(1);
  });

  it("does not over-withdraw: an IR caller of a HEALTHY callee still commits", async () => {
    const src = `
      function twice(n: number): number { return n * 2; }
      function callTwice(n: number): number { return twice(n) + 1; }
      export function test() { return callTwice(20); }`;
    const r = await compile(src, { fileName: "t.ts" });
    expect(r.success).toBe(true);
    // No parity mismatch anywhere in this module → the cascade must not fire.
    expect(r.errors.map((e) => e.message).join("\n")).not.toMatch(/parity mismatch/);
    const imports = buildImports(r.imports, {}, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, imports as WebAssembly.Imports);
    const exports = instance.exports as Record<string, (...a: unknown[]) => unknown>;
    expect(exports.test()).toBe(41);
  });
});
