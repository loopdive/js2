// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4289 — an unannotated array of anonymous objects was keyed to the first
// element's closed WasmGC struct. A later object with a different shape was
// guarded-cast to that struct, became null, and the array builder immediately
// trapped at `ref.as_non_null`. ESLint's upstream deep-merge table contains
// this exact nested-object + sibling-shape combination.

import { describe, it } from "vitest";

import { assertEquivalent } from "./equivalence/helpers.js";

describe("#4289 heterogeneous anonymous-object array carrier", () => {
  it("constructs different object shapes without trapping at module init", async () => {
    await assertEquivalent(
      `const rows = [{ a: { b: "c" } }, { d: true }];
       export function test(): number { return rows.length; }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("preserves both values after widening the carrier", async () => {
    await assertEquivalent(
      `const rows = [{ a: { b: "cat" } }, { d: true }];
       export function test(): number {
         return (rows[0] as any).a.b.length * 10 + ((rows[1] as any).d ? 1 : 0);
       }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("keeps a homogeneous anonymous-object array runnable", async () => {
    await assertEquivalent(
      `const rows = [{ a: { b: "c" } }, { a: { b: "de" } }];
       export function test(): number { return rows[0]!.a.b.length + rows[1]!.a.b.length; }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("does not reuse a closed carrier when equal outer keys have incompatible field carriers", async () => {
    await assertEquivalent(
      `function same(a: any, b: any): boolean {
         if (Object.is(a, b)) return true;
         if (a == null || b == null || typeof a !== typeof b) return false;
         if (typeof a !== "object") return false;
         if (typeof a.length === "number" || typeof b.length === "number") {
           if (typeof a.length !== "number" || typeof b.length !== "number" || a.length !== b.length) return false;
           for (let i = 0; i < a.length; i++) if (!same(a[i], b[i])) return false;
           return true;
         }
         const ak = Object.keys(a), bk = Object.keys(b);
         if (ak.length !== bk.length) return false;
         for (let i = 0; i < ak.length; i++) {
           const key = ak[i];
           if (!Object.prototype.hasOwnProperty.call(b, key) || !same(a[key], b[key])) return false;
         }
         return true;
       }
       function parse(): any[] {
         const values: any[] = [];
         const first = { type: "", params: {}, q: 1 };
         first.type = "text/plain";
         (first.params as any).meta = "a,b";
         (first.params as any).q = "0.8";
         first.q = 0.8;
         values.push(first);
         const second = { type: "", params: {}, q: 1 };
         second.type = "application/json";
         (second.params as any).q = "0.7";
         second.q = 0.7;
         values.push(second);
         return values;
       }
       const expected = [
         { type: "text/plain", params: { meta: "a,b", q: "0.8" }, q: 0.8 },
         { type: "application/json", params: { q: "0.7" }, q: 0.7 },
       ];
       export function test(): number {
         return same(parse(), expected) ? 1 : 0;
       }`,
      [{ fn: "test", args: [] }],
    );
  });
});
