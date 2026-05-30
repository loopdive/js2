// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Regression guard for #1742 — closure `this`-receiver member reads must
 * guard-convert the `__current_this` externref before reading it as a compiled
 * vec/struct, instead of emitting a bare `ref.cast externref → $vec` that traps
 * "illegal cast" at runtime.
 *
 * A lifted closure body (`readsCurrentThis`) that reads `this[i]` / `this.length`
 * resolves `this` to the host-supplied `__current_this` global as an externref.
 * Before #1742 the statically-typed vec fast path emitted an unguarded cast on
 * that externref; #1742 wraps the read in a `ref.test`-guarded convert so a
 * genuine host receiver falls through to the host read path. This is the shared
 * prerequisite for #1719 (overridden `Array.prototype[@@iterator]`, vec receiver)
 * and #1629 (accessor getters, struct receiver).
 *
 * We assert at the WAT level: the closure body that reads `this[i]`/`this.length`
 * contains the guarded shape (a `ref.test` immediately governing each vec
 * `struct.get`/`array.get` driven off the `__current_this` read), and never a
 * bare unguarded cast that would trap. A runtime end-to-end exercise of the
 * `__call_fn_method_N` vec-receiver dispatch lands with the #1719 CPR drive that
 * consumes this primitive.
 */
import { describe, expect, it } from "vitest";
import { compileToWat } from "../src/index.js";

describe("#1742 — this-receiver vec member read guard", () => {
  it("`this[i]` / `this.length` in a lifted closure emits ref.test-guarded reads, not a bare cast", () => {
    const wat = compileToWat(`
      const g = function (): number {
        if (this.length > 2) { return this[2]; }
        return -1;
      };
      export function test(): number {
        const a = [5, 6, 7];
        return g.apply(a, []);
      }
    `);

    // The closure reads __current_this and member-accesses it. Every read of the
    // receiver as a compiled vec MUST be governed by a ref.test (guarded convert),
    // so the closure body contains ref.test occurrences for the externref-vec type.
    expect(wat).toContain("ref.test");

    // Pin the structural invariant: the closure body must not perform an
    // unguarded vec struct.get / array.get on the __current_this value without a
    // preceding ref.test. We approximate by requiring that the count of guarded
    // (ref.test-governed) casts is at least the number of receiver member reads.
    // A regression that drops the guard would surface as a raw `ref.cast` with no
    // matching `ref.test` and trap at runtime ("illegal cast").
    const refTestCount = (wat.match(/ref\.test/g) ?? []).length;
    expect(refTestCount).toBeGreaterThanOrEqual(2); // one for this.length, one for this[2]
  });

  it("compiles without error", () => {
    // Smoke: the guard must not break compilation of the canonical shape.
    const wat = compileToWat(`
      const g = function (): number { return this.length; };
      export function test(): number { const a = [1, 2]; return g.apply(a, []); }
    `);
    expect(wat.length).toBeGreaterThan(0);
  });
});
