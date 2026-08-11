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
});
