// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4394 — `Array.prototype.map` (and the other higher-order members) used as a
 * VALUE must work in `--target standalone`.
 *
 * `emitArrayProtoMemberBody` implemented only `slice`; every other member
 * degraded to a catchable
 * `Array.prototype.<m> is not yet callable as a value in --target standalone`.
 * The test262 harness hits it on the very first failure it tries to REPORT:
 *
 * ```js
 * compareArray.format = function (arrayLike) {
 *   return "[" + Array.prototype.map.call(arrayLike, String).join(", ") + "]";
 * };
 * ```
 *
 * so the TypeError replaced the Test262Error the test was asserting about, and
 * `error.constructor` came back as an object. Nine standalone harness tests
 * reported a confusing constructor mismatch that had nothing to do with
 * constructors.
 *
 * The fix routes these members to `__hof_<name>`, the native standalone loop
 * that already existed for the dynamic-receiver call form. It reads its
 * receiver through `__extern_length` / `__extern_get_idx`, so it serves an
 * arbitrary array-LIKE — exactly what `.call(arguments, …)` needs.
 *
 * The receiver guard is load-bearing and is why the last test is here: the old
 * refusal threw for EVERY receiver, so `Array.prototype.map.call(undefined)`
 * passed its "must throw TypeError" test by accident. Routing to the loop
 * without a §23.1.3 step-1 ToObject check silently returns an empty result
 * instead — measured as 3 regressions before the guard was added.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function compileStandalone(source: string): Promise<string> {
  const result = (await compile(source, {
    target: "standalone",
    fileName: "test.ts",
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  } as never)) as { success: boolean; errors: { line: number; message: string }[]; wat?: string };
  expect(result.success, `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  return result.wat ?? "";
}

describe("#4394 — Array.prototype higher-order members as a value (standalone)", () => {
  it("no longer emits the not-callable-as-a-value refusal for map", async () => {
    const wat = await compileStandalone(`
declare const arrayLike: any;
export function main(): any {
  return (Array.prototype as any).map.call(arrayLike, String);
}
`);
    expect(wat).not.toContain("map is not yet callable as a value");
    // Routed to the native loop rather than a throw.
    expect(wat).toContain("__hof_map");
  });

  it("routes filter and forEach the same way", async () => {
    const wat = await compileStandalone(`
declare const arrayLike: any;
declare const cb: any;
export function a(): any { return (Array.prototype as any).filter.call(arrayLike, cb); }
export function b(): any { return (Array.prototype as any).forEach.call(arrayLike, cb); }
`);
    expect(wat).not.toContain("is not yet callable as a value");
    expect(wat).toContain("__hof_filter");
    expect(wat).toContain("__hof_forEach");
  });

  it("keeps the reduce family on the refusal (different arg shape)", async () => {
    // `__hof_reduce` takes (recv, cb, init, hasInit), not (recv, cb, thisArg);
    // routing it without marshalling those would be wrong, so it stays put.
    const wat = await compileStandalone(`
declare const arrayLike: any;
declare const cb: any;
export function main(): any { return (Array.prototype as any).reduce.call(arrayLike, cb); }
`);
    // The refusal message is built as a native string under `nativeStrings`,
    // so it is not a WAT literal — assert structurally that reduce was NOT
    // routed to the loop instead.
    expect(wat).not.toContain("__hof_reduce");
  });

  it("still guards a null/undefined receiver (§23.1.3 step 1)", async () => {
    // The guard must survive: without it `Array.prototype.map.call(undefined)`
    // returns an empty result instead of throwing.
    const wat = await compileStandalone(`
declare const arrayLike: any;
export function main(): any { return (Array.prototype as any).map.call(arrayLike, String); }
`);
    // Structural: the guard is what pulls `__extern_is_undefined` in on this
    // path (under the undefined-singleton regime `undefined` is a non-null
    // sentinel externref, so `ref.is_null` alone would miss it). The
    // BEHAVIOURAL proof is test262 built-ins/Array/prototype/map/15.4.4.19-1-1
    // and -1-2 and filter/15.4.4.20-1-2, which regressed pass->fail when this
    // guard was missing and pass again with it.
    expect(wat).toContain("__hof_map");
    expect(wat).toContain("__extern_is_undefined");
  });
});
