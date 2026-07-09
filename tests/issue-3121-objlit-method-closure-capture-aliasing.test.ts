// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3121 — closure-capture aliasing: an object-literal method and a sibling
// closure capturing the SAME function-local variable must agree on ONE store.
//
// Root cause: `promoteAccessorCapturesToGlobals` promotes a local captured by
// an object-literal method/accessor to a module global and deletes the name
// from `localMap` (so all later references route through the global). But
// `compileArrowAsClosure`'s #1177 block-shadow fallback rescanned `fctx.locals`
// BY NAME on a localMap miss, resurrecting the orphaned local slot and boxing
// it into a fresh ref cell — a second, divergent store. The method then wrote
// `__captured_c` (global) while the arrow read the stale cell: writes were
// silently invisible. The test262 runner wraps every test body in
// `function test()`, so any harness-wrapped test mixing obj-literal methods
// and closures over one mutable local (common across AsyncFromSync / for-await
// families: `returnCount` etc.) hit this.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index";

async function run(src: string, standalone: boolean): Promise<unknown> {
  const r = await compile(src, standalone ? { fileName: "test.ts", standalone: true } : { fileName: "test.ts" });
  expect(r.success, r.success ? undefined : r.errors?.map((e) => e.message).join("; ")).toBe(true);
  if (!r.success) return undefined;
  const { instance } = await WebAssembly.instantiate(r.binary, r.importObject);
  (r.importObject as { __setExports?: (e: WebAssembly.Exports) => void }).__setExports?.(instance.exports);
  return (instance.exports as { test: () => unknown }).test();
}

const CASES: Array<{ name: string; src: string; expected: number }> = [
  {
    // The canonical #3121 repro: method WRITES, sibling arrow READS.
    name: "obj-literal method write is visible to sibling arrow read",
    src: `
export function test(): number {
  var c = 0;
  const o = {
    inc() { c += 1; },
  };
  const f = () => c;
  o.inc();
  o.inc();
  return f() * 10 + c;
}`,
    expected: 22,
  },
  {
    // Reverse data flow: arrow WRITES, method READS.
    name: "sibling arrow write is visible to obj-literal method read",
    src: `
export function test(): number {
  var c = 0;
  const o = {
    get() { return c; },
  };
  const f = () => { c += 1; };
  f();
  f();
  return o.get() * 10 + c;
}`,
    expected: 22,
  },
  {
    // Arrow constructed BEFORE the literal — the #3039 box-global direction.
    name: "arrow-first ordering still shares one store with the method",
    src: `
export function test(): number {
  var c = 0;
  const f = () => c;
  const o = {
    inc() { c += 1; },
  };
  o.inc();
  o.inc();
  return f() * 10 + c;
}`,
    expected: 22,
  },
  {
    // Outer write between promotion and closure creation routes through the
    // same store as everything else.
    name: "outer write after promotion stays coherent",
    src: `
export function test(): number {
  var c = 0;
  const o = { inc() { c += 1; } };
  c = 5;
  const f = () => c;
  o.inc();
  return f() * 10 + c;
}`,
    expected: 66,
  },
  {
    // Harness-shaped: the test262 runner wraps bodies in test(); the iterator
    // return() (obj-literal method) bumps returnCount which the trailing
    // assertions read — the exact shape blocking the AsyncFromSync cluster.
    name: "harness shape: iterator return() count read after driving",
    src: `
export function test(): number {
  var returnCount = 0;
  const iter = {
    next() { return { value: 1, done: false }; },
    return() { returnCount += 1; return { done: true }; },
  };
  const check = () => returnCount;
  iter.return();
  return check() * 10 + returnCount;
}`,
    expected: 11,
  },
];

describe("#3121 obj-literal method vs sibling closure capture aliasing", () => {
  for (const { name, src, expected } of CASES) {
    for (const standalone of [false, true]) {
      it(`${name} (${standalone ? "standalone" : "js-host"})`, async () => {
        expect(await run(src, standalone)).toBe(expected);
      });
    }
  }
});
