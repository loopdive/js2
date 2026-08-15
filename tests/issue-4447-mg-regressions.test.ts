// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Merge-queue regression guards for the three codegen defects introduced by
 * #4507 — commit `044b8d09` ("fix(marked): bound upstream compilation and
 * preserve class object shapes") — and caught only by the `merge_group`
 * re-validation on the merged state.
 *
 * ATTRIBUTION (measured, not inferred). The merge-queue diff blamed PR #4567
 * (the #4445/#4446/#4447 wave), but the wave emits BYTE-IDENTICAL wasm for
 * every affected test: the `wasm_sha` for each file is the same with and
 * without the wave, and differs only across `044b8d09`. First-parent bisect
 * over `main`: `c3ff8a1f` GOOD → `6756ed8c` (the #4507 merge) BAD, isolated to
 * `044b8d09`, whose parent `57228240` is GOOD.
 *
 *   A. `collectMethodEntries` began admitting an UNDER-APPLIED call whose
 *      omitted formal is reference-typed. The dispatcher can only fabricate a
 *      faithful "argument absent" value for a constant default or an `f64`
 *      (sNaN sentinel) slot; a reference slot degrades to `ref.null`, which the
 *      callee cannot tell from an explicit `null`, so it SKIPS its default —
 *      `method({} = obj)` threw "Cannot destructure 'null' or 'undefined'".
 *
 *   B. Object-literal spread lost its `native-first` gate, so the HOST lane
 *      began materializing a closed-struct spread source into an open
 *      `$Object`. That takes an eager SNAPSHOT at source-evaluation time rather
 *      than passing a live reference, breaking spec ordering when an earlier
 *      source's getter mutates a later one.
 *
 *   C. The method-trampoline `this`-slot gained a coercion guarded on
 *      `ValType.kind`. The real case is `ref_null <S>` → `ref <S>` — the SAME
 *      struct differing only in NULLABILITY — and `"ref_null" !== "ref"`, so
 *      the guard fell through and emitted a null-eliminating cast over the
 *      deliberate `ref.null` passthrough (#2025), trapping with "dereferencing
 *      a null pointer". This also grew the #3189 null_deref trap ratchet 140→142.
 *
 * These assert against the ACTUAL upstream test262 files rather than reduced
 * snippets on purpose: each defect needs the dynamic-dispatch / getter-ordering
 * / foreign-receiver shape that the generated files produce, and hand-reduced
 * versions kept hitting unrelated pre-existing gaps instead (which would make
 * the guard pass for the wrong reason).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const T262 = join(__dirname, "..", "test262");
const HAVE_T262 = existsSync(join(T262, "harness", "assert.js"));
const abs = (rel: string) => join(T262, "test", rel);

describe.skipIf(!HAVE_T262)("#4507 regressions — must pass on the gc (host) lane", () => {
  const files = [
    // A — empty object pattern WITH a default, as a method parameter.
    "language/expressions/object/dstr/meth-dflt-obj-ptrn-empty.js",
    "language/expressions/object/dstr/gen-meth-dflt-obj-ptrn-empty.js",
    "language/expressions/object/dstr/async-gen-meth-dflt-obj-ptrn-empty.js",
    // B — object spread where a getter mutates a later spread source.
    "language/expressions/array/spread-obj-manipulate-outter-obj-in-getter.js",
    "language/expressions/new/spread-obj-manipulate-outter-obj-in-getter.js",
    "language/expressions/super/call-spread-obj-manipulate-outter-obj-in-getter.js",
    // C — private method extracted as a value and `.call()`ed on a foreign shape.
    "language/statements/class/elements/super-access-inside-a-private-method.js",
  ];
  for (const rel of files) {
    it(`${rel}`, { timeout: 60_000 }, async () => {
      const r = await runTest262File(abs(rel), "issue-4447-mg", 30_000);
      expect(`${r.status}: ${r.error ?? ""}`).toBe("pass: ");
    });
  }
});

describe.skipIf(!HAVE_T262)("#4507 regression C — trap ratchet (#3189) must not grow", () => {
  // This file does NOT pass — it is a known, pre-existing FAILURE. What #4507
  // changed is its KIND: an ordinary assertion failure became a hard
  // `dereferencing a null pointer` trap, which is what pushed the null_deref
  // ratchet 140→142. Asserting "still fails, but never traps" is therefore the
  // precise guard; asserting `pass` would be wrong and would rot.
  it("private-method-get-and-call fails WITHOUT trapping", { timeout: 60_000 }, async () => {
    const r = await runTest262File(
      abs("language/statements/class/elements/private-method-get-and-call.js"),
      "issue-4447-mg",
      30_000,
    );
    expect(r.status).not.toBe("pass"); // if this ever flips, tighten the guard
    expect(r.error ?? "").not.toMatch(/dereferencing a null pointer/);
    expect(r.error ?? "").not.toMatch(/RuntimeError/);
  });
});

describe.skipIf(!HAVE_T262)("#4507 regression B — standalone lane must be untouched", () => {
  // The fix restores the `native-first` gate, so the STANDALONE lane keeps the
  // materialization it needs (#3222 C1) and its binaries are unchanged. These
  // files still fail there for unrelated, pre-existing reasons; the guard is
  // that the host-lane fix did not disturb the standalone lowering.
  const files = [
    "language/expressions/array/spread-obj-manipulate-outter-obj-in-getter.js",
    "language/expressions/new/spread-obj-manipulate-outter-obj-in-getter.js",
    "language/expressions/super/call-spread-obj-manipulate-outter-obj-in-getter.js",
  ];
  for (const rel of files) {
    it(`${rel} still compiles on standalone`, { timeout: 60_000 }, async () => {
      const r = await runTest262File(abs(rel), "issue-4447-mg", 30_000, "standalone");
      // Not a compile error and not a trap — the pre-existing failure is an
      // ordinary assertion mismatch.
      expect(r.status).not.toBe("compile_error");
      expect(r.error ?? "").not.toMatch(/dereferencing a null pointer/);
    });
  }
});
