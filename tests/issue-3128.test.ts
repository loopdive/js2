// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3128 — assignment lost when the RHS contains a closure capturing the
// assigned variable (`p2 = p1.then(function(){ return p2; })`).
//
// Three stacked root causes, all fixed here:
//
//  A. assignment.ts resolved the LHS local index BEFORE compiling the RHS;
//     a closure inside the RHS that captures the SAME name boxes the local
//     into a fresh ref cell mid-RHS (closures.ts construction-site boxing)
//     and re-points `fctx.localMap` — the pre-resolved raw-index write then
//     bypassed the cell, so the closure (and every later read) saw the stale
//     pre-assignment value. Fix: re-resolve the storage after the RHS and
//     write through the live store (mirrors variables.ts #1177/#2692/#1672).
//
//  B. The capture-mutability walk (`writtenInOuter`) stopped at the nearest
//     AST function boundary — even when that boundary was an IIFE the
//     call-site inliner had flattened into the current fctx (no Wasm scope).
//     Writes in the REAL enclosing body were invisible, so the capture went
//     by-value: a stale copy. Fix: record inlined IIFE nodes on the fctx and
//     walk past them (unless the IIFE itself declares the name — shadows
//     keep their own binding).
//
//  C. A zero-arg dynamic call (`resolve()` inside a `new Promise` executor)
//     excluded over-arity VOID closures from the dispatch candidates (#1837
//     gate), so the canonical `(externref) -> ()` settle closure silently
//     never ran and the promise stayed pending forever. Fix: re-admit
//     over-arity void candidates whose padded formals are all externref
//     (§7.3.14 missing args are `undefined`).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index";

async function run(src: string, standalone: boolean): Promise<unknown> {
  // NOTE (#3128 rescue): the standalone lane MUST be selected via
  // `target: "standalone"` — the codegen `standalone` flag derives ONLY from
  // `options.target === "standalone"` (compiler.ts buildCodegenOptions); a
  // top-level `{ standalone: true }` compile option is silently ignored and
  // compiles the default gc-host lane, which is what this file originally
  // (and vacuously) tested twice.
  const r = await compile(src, standalone ? { fileName: "test.ts", target: "standalone" } : { fileName: "test.ts" });
  expect(r.success, r.success ? undefined : r.errors?.map((e) => e.message).join("; ")).toBe(true);
  if (!r.success) return undefined;
  const { instance } = await WebAssembly.instantiate(r.binary, r.importObject);
  (r.importObject as { __setExports?: (e: WebAssembly.Exports) => void }).__setExports?.(instance.exports);
  return (instance.exports as { test: () => unknown }).test();
}

// #3136 (FIXED): the two cases that assert `closureRead() === p2` OBJECT
// IDENTITY previously hit a standalone-only boxed-cell-read identity-loss bug
// (independent of #3128 — the tag-5 host-only strict-eq arm,
// reference_2583_any_strict_eq_tag5_host_only). They used `standaloneSrc`
// variants that only checked the VALUE through the cell. That bug is now fixed,
// so the `standaloneSrc` relaxations were removed and the identity assertions
// run on BOTH lanes.
const CASES: Array<{ name: string; src: string; expected: number; standaloneSrc?: string }> = [
  {
    // The issue's table row: plain-object RHS, no Promise involved.
    name: "assignment visible after RHS-closure self-capture (plain object RHS)",
    src: `
export function test(): number {
  var p2: any;
  p2 = (function(){ return { a: (function(){ return p2; }) }; })();
  if (p2 === null || p2 === undefined) return 9;
  return 1;
}`,
    expected: 1,
  },
  {
    name: "assignment visible after RHS-closure self-capture (arrow IIFE RHS)",
    src: `
export function test(): number {
  var p2: any;
  p2 = (() => ({ a: () => p2 }))();
  if (p2 === null || p2 === undefined) return 9;
  return 1;
}`,
    expected: 1,
  },
  {
    // The load-bearing case: the ESCAPED closure must read back the
    // POST-assignment value — this is what `p1.then(() => p2)` needs.
    name: "escaped self-capturing closure reads the post-assignment value",
    src: `
export function test(): number {
  var p2: any;
  var captured: any;
  p2 = (function(){ captured = (function(){ return p2; }); return { a: 1 }; })();
  if (p2 === null || p2 === undefined) return 9;
  if (captured() !== p2) return 8;
  return 1;
}`,
    expected: 1,
  },
  {
    // Control: sibling closure NOT inside the assignment RHS keeps working.
    name: "sibling closure outside the RHS still coherent",
    src: `
export function test(): number {
  var p2: any;
  var f = function(){ return p2; };
  p2 = (function(){ return { a: 1 }; })();
  if (p2 === null || p2 === undefined) return 9;
  if (f() !== p2) return 8;
  return 1;
}`,
    expected: 1,
  },
  {
    // Shadow guard for fix B: the IIFE's OWN `var x` is a different binding —
    // the outer write must NOT be conflated into the shadow's capture.
    name: "IIFE-local shadow not conflated with outer writes",
    src: `
export function test(): number {
  var x = 1;
  var f: any = (function(){ var x = 5; return (function(){ return x; }); })();
  x = 2;
  return (f() === 5 && x === 2) ? 1 : 0;
}`,
    expected: 1,
  },
  {
    name: "IIFE var shadow leaves the captured outer binding intact",
    src: `
export function test(): number {
  var x = 1;
  var readOuter = function(): number { return x; };
  (function(): void { var x = 5; if (x !== 5) throw new Error("bad inner binding"); })();
  return readOuter() * 10 + x;
}`,
    expected: 11,
  },
  {
    name: "IIFE parameter does not leak over a same-named outer binding",
    src: `
export function test(): number {
  var x = 3;
  (function(x: number): void { void x; })(5);
  return x;
}`,
    expected: 3,
  },
  {
    // Write INSIDE the inlined IIFE stays visible outside (both directions).
    name: "write inside inlined IIFE visible to escaped closure and outer reads",
    src: `
export function test(): number {
  var c = 0;
  var get: any = (function(){ c = 7; return (function(){ return c; }); })();
  c = c + 1;
  return get() === 8 ? 1 : 0;
}`,
    expected: 1,
  },
];

describe("#3128 assignment-RHS closure self-capture aliasing", () => {
  for (const { name, src, expected, standaloneSrc } of CASES) {
    for (const standalone of [false, true]) {
      it(`${name} (${standalone ? "standalone" : "js-host"})`, async () => {
        expect(await run(standalone && standaloneSrc ? standaloneSrc : src, standalone)).toBe(expected);
      });
    }
  }
});

// ── C: zero-arg dynamic call of the (externref)->() settle closure ─────────
// These need the widened-standalone native promise carrier; the toggle is
// read at MODULE LOAD of async-scheduler.ts, so a separate vitest fork with
// the env set (mirrors tests/issue-3125-widen.test.ts) would be required to
// exercise the executor shape natively. Instead we pin the DISPATCH fix
// directly: a 0-arg call of an any-typed 1-param void closure must invoke it
// with `undefined`, not silently no-op.
describe("#3128 zero-arg dynamic call dispatches over-arity void closures", () => {
  for (const standalone of [false, true]) {
    it(`fn() with 1-param void closure runs the body (${standalone ? "standalone" : "js-host"})`, async () => {
      const src = `
let ran = 0;
function invoke(fn: any): void {
  fn(); // zero-arg call of a (externref) -> void closure
}
export function test(): number {
  var seen: any = 'unset';
  invoke(function(v: any) { ran = 1; seen = v; });
  if (ran !== 1) return 0;       // body must RUN
  if (seen === 'unset') return 2; // param must be filled (undefined pad)
  return 1;
}`;
      expect(await run(src, standalone)).toBe(1);
    });
  }
});
