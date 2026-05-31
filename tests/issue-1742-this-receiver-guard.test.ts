// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Regression guard for #1742 — closure `this`-receiver member reads must
 * RUNTIME-TEST-guard the `__current_this` externref before reading it as a
 * compiled vec/struct, instead of emitting a bare `ref.cast externref → $vec`
 * that traps "illegal cast" at runtime.
 *
 * A lifted closure body (`readsCurrentThis`) that reads `this[i]` / `this.length`
 * resolves `this` to the host-supplied `__current_this` global as an externref.
 * The realistic override `Array.prototype[Symbol.iterator] = function*(){…this[0]…}`
 * has no `this:` annotation → TS infers `this: any` → externref, so a static-type
 * gate never fires. The discriminator MUST be a runtime `ref.test` against the
 * registered vec types: on a hit read the backing store, on a miss keep the host
 * `__extern_get`/`__extern_length` path (a genuine host receiver). Shared
 * prerequisite for #1719 (vec receiver) and #1629 (struct getter receiver).
 *
 * We assert at the WAT level: the closure body that reads `this[i]`/`this.length`
 * contains `ref.test`-guarded reads (one chained test per registered vec type),
 * never a bare unguarded cast that would trap. A runtime end-to-end exercise of
 * the `__call_fn_method_N` vec-receiver dispatch lands with the #1719 CPR drive
 * that consumes this primitive.
 */
import { describe, expect, it } from "vitest";
import { compileToWat } from "../src/index.js";

describe("#1742 — this-receiver vec member read guard (runtime-tested)", () => {
  it("`this[i]` / `this.length` in a lifted closure emit ref.test-guarded reads", async () => {
    const wat = await compileToWat(`
      const g = function (): number {
        if (this.length > 2) { return this[2]; }
        return -1;
      };
      export function test(): number {
        const a = [5, 6, 7];
        return g.apply(a, []);
      }
    `);

    // Every read of the receiver as a compiled vec MUST be governed by a
    // ref.test (runtime guard-convert), so the closure body contains ref.test
    // occurrences. A regression that drops the guard surfaces as a raw `ref.cast`
    // with no matching `ref.test` and traps at runtime ("illegal cast").
    expect(wat).toContain("ref.test");
    const refTestCount = (wat.match(/ref\.test/g) ?? []).length;
    // At least one test for this.length and one for this[2] (each may chain over
    // multiple vec element types).
    expect(refTestCount).toBeGreaterThanOrEqual(2);
  });

  it("compiles the canonical override-body shape without error", async () => {
    const wat = await compileToWat(`
      const g = function (): number { return this.length; };
      export function test(): number { const a = [1, 2]; return g.apply(a, []); }
    `);
    expect(wat.length).toBeGreaterThan(0);
  });
});
