// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6997 — `==` / `!=` between two OBJECT operands is identity (§7.2.15 step 1:
// same Type ⇒ IsStrictlyEqual). The typed dispatch used to ToPrimitive both
// struct refs to f64 and `f64.eq` them, so the same instance compared `false`
// (NaN ≠ NaN) and two distinct `{ valueOf() { return 1 } }` compared `true`.
// Both lanes; the mixed object-vs-primitive rows are controls that must still
// coerce through ToPrimitive.
import { describe, expect, it } from "vitest";
import { compile } from "../../src/index.js";
import { assertEquivalent, evaluateAsJs } from "./helpers.js";

async function assertStandaloneEquivalent(source: string): Promise<void> {
  const result = await compile(source, { fileName: "issue-6997.ts", target: "standalone" });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const exports = instance.exports as Record<string, () => unknown>;
  exports.__module_init?.();
  expect(exports.test!()).toBe(evaluateAsJs(source).test!());
}

const CASES: [string, string][] = [
  [
    "same class instance",
    `class C { v = 1 }
     export function test(): number { const c = new C(); const e = c; return (c == e ? 1 : 0) + (c != e ? 10 : 0); }`,
  ],
  [
    "C | null parameters, including null == null",
    `class C { v = 1 }
     function same(a: C | null, b: C | null): boolean { return a == b }
     export function test(): number {
       const c = new C();
       return (same(c, c) ? 1 : 0) + (same(null, null) ? 10 : 0) + (same(c, null) ? 100 : 0) + (same(c, new C()) ? 1000 : 0);
     }`,
  ],
  [
    "C | undefined against C | null (undefined == null is true)",
    `class C { v = 1 }
     function same(a: C | undefined, b: C | null): boolean { return a == b }
     export function test(): number {
       const c = new C();
       return (same(c, c) ? 1 : 0) + (same(undefined, null) ? 10 : 0) + (same(c, null) ? 100 : 0) + (same(undefined, c) ? 1000 : 0);
     }`,
  ],
  [
    "array identity",
    `export function test(): number { const a = [1]; const b = a; return (a == b ? 1 : 0) + (a != b ? 10 : 0) + (a == [1] ? 100 : 0); }`,
  ],
  [
    "Map identity",
    `export function test(): number { const m = new Map<number, number>(); const n = m; return (m == n ? 1 : 0) + (m != new Map<number, number>() ? 10 : 0); }`,
  ],
  [
    "Date identity (equal time values are still distinct objects)",
    `export function test(): number { const d = new Date(5); const e = d; const f = new Date(5); return (d == e ? 1 : 0) + (d == f ? 10 : 0) + (d != f ? 100 : 0); }`,
  ],
  [
    "two distinct valueOf objects are not loosely equal",
    `class V { valueOf(): number { return 1 } }
     export function test(): number { const a = new V(); const b = new V(); return (a == b ? 1 : 0) + (a == a ? 10 : 0); }`,
  ],
  [
    "two distinct valueOf object literals are not loosely equal",
    `export function test(): number { const a = { valueOf() { return 1 } }; const b = { valueOf() { return 1 } }; return (a == b ? 1 : 0) + (a == a ? 10 : 0); }`,
  ],
  [
    "findIndex with a loose-equality predicate",
    `class C { constructor(public v: number) {} }
     export function test(): number { const a = new C(1), b = new C(2), c = new C(3); const list = [a, b, c]; const x = b; return list.findIndex((y) => y == x); }`,
  ],
  [
    "union of two classes",
    `class C { v = 1 } class D { w = 2 }
     function differ(a: C | D, b: C | D): boolean { return a != b }
     export function test(): number { const c = new C(), d = new D(); return (differ(c, c) ? 1 : 0) + (differ(c, d) ? 10 : 0); }`,
  ],
  [
    "\`object\`-typed parameters",
    `function same(a: object, b: object): boolean { return a == b }
     export function test(): number { const o = { x: 1 }; return (same(o, o) ? 1 : 0) + (same(o, { x: 1 }) ? 10 : 0); }`,
  ],
  [
    "function identity",
    `export function test(): number { const f = () => 1; const g = f; const h = () => 1; return (f == g ? 1 : 0) + (f == h ? 10 : 0); }`,
  ],
  [
    "wrapper objects compare by identity; wrapper vs number still coerces",
    `export function test(): number { const a = new Number(1); const b = new Number(1); const c = a; return (a == b ? 1 : 0) + (a == c ? 10 : 0) + ((a as any) == 1 ? 100 : 0); }`,
  ],
  [
    "control: object vs number still goes through ToPrimitive",
    `class V { valueOf(): number { return 3 } }
     export function test(): number { const v = new V(); const n: number = 3; return ((v as any) == n ? 1 : 0) + ((v as any) != 4 ? 10 : 0); }`,
  ],
  [
    "IR-claimed: any parameters holding objects",
    `export function same(a: any, b: any): boolean { return a == b }
     export function test(): number {
       const x = { x: 1 }; const v = { valueOf() { return 1 } }; const w = { valueOf() { return 1 } };
       return (same(x, x) ? 1 : 0) + (same(x, { x: 1 }) ? 10 : 0) + (same(v, w) ? 100 : 0);
     }`,
  ],
  [
    "IR-claimed: object-literal locals in test()",
    `export function test(): number { const x = { x: 1 }; const y = x; const z = { x: 1 }; return (x == y ? 1 : 0) + (x == z ? 10 : 0) + (x != z ? 100 : 0); }`,
  ],
];

describe("#6997 loose equality between two objects is identity", () => {
  for (const [name, src] of CASES) {
    it(`gc: ${name}`, async () => {
      await assertEquivalent(src, [{ fn: "test", args: [] }]);
    }, 60_000);
    it(`standalone: ${name}`, async () => {
      await assertStandaloneEquivalent(src);
    }, 60_000);
  }
});
