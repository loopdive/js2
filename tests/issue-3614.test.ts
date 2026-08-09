// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #3614 — a standalone `Test262Error` instance's `.constructor` read `undefined`.
 *
 * `emitStandaloneTest262Error` (#2902) lowers `new Test262Error(msg)` to an
 * `$Error_struct` with `$name = "Test262Error"`. The `constructor` key arm in
 * `fillExternGetErrorProps` answered only BUILTIN error constructors — its
 * `Error` arm is `$name === "Error"`-guarded precisely because Test262Error
 * SHARES the `Error` tag — so the read fell through to the standard miss.
 *
 * Upstream `harness/assert.js` runs
 * `thrown.constructor !== expectedErrorConstructor` on EVERY caught value, so
 * `undefined !== <closure>` rejected throws that were exactly correct. 924 of
 * the 5,114 standalone tests de-vacuified by #3592 failed on this alone (854
 * of them via `assert.throws(Test262Error, …)`).
 *
 * These tests assert OBSERVABLE VALUES returned from the instantiated module —
 * never merely "it compiles". Two shape requirements are load-bearing and were
 * both established empirically:
 *
 *  1. `new Test262Error(…)` must be written with a BARE IDENTIFIER callee.
 *     `new (Test262Error as any)(…)` is a parenthesized `AsExpression`, which
 *     fails the `ts.isIdentifier` gate in `new-builtin-globals.ts`, so no
 *     `$Error_struct` is minted and the test would silently exercise the
 *     generic fnctor path instead of the code under test.
 *  2. Every identity comparison happens inside a CALLEE, on a PARAMETER — the
 *     shape `assert.throws(Test262Error, fn)` actually uses. A static
 *     identifier-to-identifier comparison would take a different, already
 *     working path.
 *
 * Verified to be a genuine regression test: with the `userCtorArms` block
 * removed from `fillExternGetErrorProps`, the first two cases below invert
 * (`thrown.constructor` is `undefined`, the identity is `false`).
 */

const PRELUDE = `
function Test262Error(this: any, message: any) {
  (this as any).message = message;
}
// A second, unrelated compiled constructor — the cross-check that the identity
// answered is the RIGHT one and not just "any non-undefined object".
function OtherError(this: any, message: any) {
  (this as any).message = message;
}
// The comparisons live in callees taking their operands as PARAMETERS, which is
// the shape harness/assert.js's \`assert.throws\` uses.
function matches(expected: any, thrown: any): boolean {
  return thrown.constructor === expected;
}
function ctorIsUndefined(thrown: any): boolean {
  return thrown.constructor === undefined;
}
function sameCtor(a: any, b: any): boolean {
  return a.constructor === b.constructor;
}
// Evaluates its argument as a VALUE and nothing else. The fix answers
// \`.constructor\` by READING the \`__fn_closure_Test262Error\` global and never
// materializes it (materializing would mean minting a \`ref.func\` trampoline at
// finalize — the late-funcidx-shift hazard). So the global is non-null only
// once the identifier has been evaluated as a value somewhere in the module.
// \`assert.throws(Test262Error, fn)\` always does exactly that; \`keep()\` is the
// minimal stand-in for it.
function keep(v: any): boolean {
  return v !== undefined;
}
`;

async function runStandalone(body: string): Promise<number> {
  const src = `${PRELUDE}\nexport function test(): number {\n${body}\n}\n`;
  const r = await compile(src, { target: "standalone", nativeStrings: true });
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
  // Standalone must stay host-free for this shape. If a host import crept in,
  // the assertions below would be measuring the JS host rather than the Wasm.
  expect(r.imports).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number }).test();
}

/** Throws and catches a Test262Error, leaving it in `thrown`. */
const THROW_AND_CATCH = `
  let thrown: any = undefined;
  try {
    throw new Test262Error("boom");
  } catch (e) {
    thrown = e;
  }
`;

describe("#3614 — standalone Test262Error instance .constructor identity", () => {
  it("thrown.constructor === Test262Error holds through a function parameter", async () => {
    // Pre-fix: 0. This is the single comparison the 854-test cluster failed on.
    expect(
      await runStandalone(`
        ${THROW_AND_CATCH}
        return matches(Test262Error, thrown) ? 1 : 0;
      `),
    ).toBe(1);
  });

  it("thrown.constructor is no longer undefined", async () => {
    // Pre-fix: 1. Separated from the identity check so a regression that makes
    // `.constructor` answer *something wrong* is distinguishable from one that
    // makes it answer nothing at all.
    expect(
      await runStandalone(`
        ${THROW_AND_CATCH}
        keep(Test262Error);
        return ctorIsUndefined(thrown) ? 1 : 0;
      `),
    ).toBe(0);
  });

  it("the identity is genuine — a different compiled constructor does not match", async () => {
    // Guards against a vacuous fix: if `.constructor` answered a single shared
    // carrier (or if both sides collapsed to `undefined`, as pre-fix), this
    // would also report a match.
    expect(
      await runStandalone(`
        ${THROW_AND_CATCH}
        return matches(OtherError, thrown) ? 1 : 0;
      `),
    ).toBe(0);
  });

  it("both directions hold in one module: right ctor matches, wrong ctor does not", async () => {
    // The two cross-checks above, in a SINGLE compilation unit, so a fix that
    // only works when exactly one constructor exists cannot pass.
    expect(
      await runStandalone(`
        ${THROW_AND_CATCH}
        if (!matches(Test262Error, thrown)) { return 0; }
        if (matches(OtherError, thrown)) { return 0; }
        if (ctorIsUndefined(thrown)) { return 0; }
        return 1;
      `),
    ).toBe(1);
  });

  it("two Test262Error instances answer the SAME constructor object", async () => {
    // Cross-instance stability: the arm must answer one identity-stable global,
    // not a freshly materialized object per read. Paired with the
    // `!ctorIsUndefined` guard so `undefined === undefined` cannot satisfy it.
    expect(
      await runStandalone(`
        let a: any = undefined;
        let b: any = undefined;
        try { throw new Test262Error("one"); } catch (e) { a = e; }
        try { throw new Test262Error("two"); } catch (e) { b = e; }
        keep(Test262Error);
        if (ctorIsUndefined(a)) { return 0; }
        return sameCtor(a, b) ? 1 : 0;
      `),
    ).toBe(1);
  });

  it("declines (keeps the legacy miss) when the identifier is never read as a value", async () => {
    // Pins the deliberate read-only contract rather than letting it be an
    // accident: with no value read of `Test262Error` anywhere in the module the
    // closure global is null, so the arm falls through to the historical miss.
    // Harmless — with nothing holding the other side, no identity comparison is
    // expressible — but it must not change silently, because the alternative
    // (materializing the closure from `fillExternGetErrorProps`) would require
    // minting a `ref.func` trampoline at FINALIZE.
    expect(
      await runStandalone(`
        ${THROW_AND_CATCH}
        return ctorIsUndefined(thrown) ? 1 : 0;
      `),
    ).toBe(1);
  });

  it("a genuine new Error() does not report Test262Error as its constructor", async () => {
    // The `$name` discriminator must not be bypassed: `Error` and
    // `Test262Error` SHARE the Error tag, so a tag-keyed arm would cross-wire
    // them. Also asserts the real Error still answers *something* (#3006's
    // builtin carrier), so this is not passing merely because the read missed.
    expect(
      await runStandalone(`
        let thrown: any = undefined;
        try {
          throw new Error("boom");
        } catch (e) {
          thrown = e;
        }
        if (ctorIsUndefined(thrown)) { return 0; }
        return matches(Test262Error, thrown) ? 0 : 1;
      `),
    ).toBe(1);
  });
});
