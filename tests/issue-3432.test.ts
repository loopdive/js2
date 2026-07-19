// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3432 — a callable externref initializer assigned to an externref-slot var
// must NOT be round-tripped through a signature-matched closure-struct cast:
// closure wrapper structs are sibling `sub final` types with creation-order-
// dependent RTTs (#2873), so the guarded cast nulled closures of any sibling
// wrapper (testTypedArray.js `argFactory.bind(...)` → "bind called on
// non-callable"). The value must survive the read verbatim.
import { describe, expect, it } from "vitest";
import { compileAndInstantiate } from "../src/runtime.js";

describe("#3432 closure values read from arrays into externref-slot vars survive", () => {
  it("declaration closures with differing signatures read from one array all stay callable", async () => {
    const ex = (await compileAndInstantiate(`
function passthrough(a: any, b: any) { return b; }
function toArray(a: any, b: any) { return [b]; }
function toLen(a: any, b: any) { return b + 1; }
var factories: any = [passthrough, toArray, toLen];
export function test(): number {
  var fs: any = factories;
  var ok = 0;
  for (var k = 0; k < fs.length; ++k) {
    var f: any = fs[k];
    if (f === null || f === undefined) continue;
    var bound: any = f.bind(undefined, 0);
    if (typeof bound === "function") ok++;
  }
  return ok;
}
`)) as Record<string, unknown>;
    expect((ex.test as () => number)()).toBe(3);
  });

  it("bound element from array invokes the right target with prepended arg", async () => {
    const ex = (await compileAndInstantiate(`
function add(a: any, b: any) { return a + b; }
var fs: any = [add];
export function test(): number {
  var f: any = fs[0];
  var bound: any = f.bind(undefined, 40);
  return bound(2);
}
`)) as Record<string, unknown>;
    expect((ex.test as () => number)()).toBe(42);
  });

  // (#3432 follow-up — the +107 null_deref merge_group cluster) Skipping the
  // recast leaves a raw externref in the slot, which can be a FOREIGN callable
  // (host builtin / bridge-wrapped closure read off a property, e.g. test262
  // harness `var format = compareArray.format; … format(actual)`). A DIRECT
  // call of such a var must dispatch through the #1712 `__call_function` host
  // arm — without it the closure-struct dispatch nulls the guarded root cast
  // and traps "dereferencing a null pointer" (RuntimeError, uncatchable).
  it("direct call of a skipped-recast externref var holding a host function does not trap", async () => {
    const ex = (await compileAndInstantiate(`
// Register a closure with a matching wasm signature so the decl below finds a
// matchedClosureInfo (stand-in for the harness's many sibling closures).
var sibling: any = function (x: any): any { return x; };
export function test(): number {
  var isNaNFn: (x: any) => any = (globalThis as any).isNaN;
  var r: any = isNaNFn(0 / 0);
  return r === true ? 1 : 0;
}
`)) as Record<string, unknown>;
    expect((ex.test as () => number)()).toBe(1);
  });
});
