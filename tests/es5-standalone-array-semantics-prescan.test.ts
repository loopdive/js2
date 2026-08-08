// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4222) The `vecIndexDeleteDirty` pre-scan predicate.
//
// This flag is what arms the overlay route for a module whose only overlay
// writer is a `delete arr[i]` — without it the typed lanes keep answering
// presence from `0 <= i < length`, which `delete` does not change. It is a
// per-module over-approximation set BEFORE any body compiles (same discipline
// as #4159's `vecAccessorDescriptorDirty`), so the predicate itself is the
// thing worth pinning: a false negative silently restores the old wrong answer,
// and a false positive costs every array in the module its dense fast path.
import { describe, expect, it } from "vitest";
// `src/index.js` first — see the note in issue-4159-4160-prescan-flags.test.ts:
// importing `array-holes.js` alone trips a circular-import TDZ.
import "../src/index.js";
import { ts } from "../src/ts-api.js";
import { scanForArrayHoles } from "../src/codegen/array-holes.js";
import type { CodegenContext } from "../src/codegen/context/types.js";

function scanDelete(src: string): boolean {
  const sf = ts.createSourceFile("t.ts", src, ts.ScriptTarget.ES2022, true);
  const ctx = {
    usesArrayHoles: false,
    protoIndexDirty: false,
    protoNamedDirty: false,
    vecAccessorDescriptorDirty: false,
    vecIndexDeleteDirty: false,
    dynamicCodeDirty: false,
  } as unknown as CodegenContext;
  scanForArrayHoles(ctx, sf);
  return ctx.vecIndexDeleteDirty;
}

describe("#4222 — vecIndexDeleteDirty fires on a computed delete", () => {
  it("a literal index sets it", () => {
    expect(scanDelete(`const a = [1, 2]; delete a[1];`)).toBe(true);
  });

  it("a non-literal index sets it — the dominant test262 shape", () => {
    expect(scanDelete(`declare const i: number; const a = [1, 2]; delete a[i];`)).toBe(true);
  });

  it("a string-literal key sets it (an array index reached via ToPropertyKey)", () => {
    expect(scanDelete(`const a = [1, 2]; delete a["1"];`)).toBe(true);
  });

  it("a delete nested inside a callback sets it (15.4.4.20-9-3's shape)", () => {
    expect(
      scanDelete(`const a = [1, 2, 3];
        a.filter(function () { delete a[2]; return true; });`),
    ).toBe(true);
  });

  it("a parenthesised / cast operand still matches", () => {
    expect(scanDelete(`const a: any = [1, 2]; delete (a as any)[1];`)).toBe(true);
  });
});

describe("#4222 — vecIndexDeleteDirty does NOT fire on a dotted delete", () => {
  // A dotted name can never be an array index, so it cannot tombstone a dense
  // vec slot. Matching it would arm the overlay route for the ubiquitous
  // `delete obj.field` idiom and cost every array in such a module its dense
  // fast path for nothing.
  it("delete obj.field leaves it clear", () => {
    expect(scanDelete(`const o: any = { x: 1 }; delete o.x;`)).toBe(false);
  });

  it("delete this.field leaves it clear", () => {
    expect(scanDelete(`function f(this: any) { delete this.x; }`)).toBe(false);
  });

  it("a module with no delete at all leaves it clear", () => {
    expect(scanDelete(`const a = [1, 2]; a.filter(function () { return true; });`)).toBe(false);
  });
});

describe("#4222 — dynamic code forces it", () => {
  // Static eval inlining (#1163) splices statements in AFTER this pass, so
  // `eval("delete a[0]")` would otherwise leave the flag clear — the exact
  // read/store desync the pre-pass exists to prevent (#4159/#4160).
  it("eval(…) sets it even with no syntactic delete", () => {
    expect(scanDelete(`declare const s: string; eval(s);`)).toBe(true);
  });

  it("Function(…) sets it", () => {
    expect(scanDelete(`declare const s: string; Function(s);`)).toBe(true);
  });
});
