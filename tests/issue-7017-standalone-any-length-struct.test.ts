// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #7017 — `.length` on an `any` receiver that is a user-declared struct (an
 * object literal, a class or constructor-function instance) in `--target
 * standalone` must be the real Get: the shape's `length` field or getter when
 * it has one, else an expando / inherited `length`, else `undefined`.
 *
 * The standalone lowering sent every such receiver to `__extern_length`
 * (ToLength(Get)), so a plain `{ type: "A" }` read `length === 0`,
 * `typeof x.length === "number"` was true, and every deep-equality helper that
 * detects array-likes that way (the upstream suites' `toEqual`, QUnit
 * `deepEqual`) compared two object literals as empty array-likes: equal
 * whatever their contents.
 */
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import {
  STANDALONE_COMPILE_OVERRIDES,
  UPSTREAM_TEST_STANDALONE_EXPORTS,
  instantiateStandaloneResult,
  runStandaloneUpstreamTests,
  // @ts-expect-error — .mjs dogfood lane has no declaration file
} from "./dogfood/upstream-standalone-lane.mjs";
// @ts-expect-error — .mjs dogfood runner has no declaration file
import { UPSTREAM_TEST_EXPORTS, UPSTREAM_TEST_SHIM } from "./dogfood/upstream-suite-runner.mjs";

async function runStandalone(source: string): Promise<Record<string, number>> {
  const result = await compile(source, { target: "standalone", fileName: "any-length.ts", emitWat: false });
  expect(result.success, JSON.stringify(result.errors?.slice(0, 3))).toBe(true);
  const module = new WebAssembly.Module(result.binary!);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const exports = new WebAssembly.Instance(module, {}).exports as Record<string, () => number>;
  const out: Record<string, number> = {};
  for (const name of Object.keys(exports).filter((k) => /^t\d+$/.test(k))) out[name] = exports[name]!();
  return out;
}

/** Every value below is what node answers for the same source. */
const READS = `
// The issue's repros: a literal reached through a local any[] filled by push.
export function t1(): number { const xs: any[] = []; xs.push({ type: "A" }); const e: any = xs[0]; return typeof e.length === "number" ? 1 : 0; }
export function t2(): number { const xs: any[] = []; xs.push({ type: "A" }); const e: any = xs[0]; return e.length === undefined ? 1 : 0; }
// Control: a literal assigned straight to an any is widened to $Object (correct before the fix).
export function t3(): number { const e: any = { type: "A" }; return typeof e.length === "number" ? 1 : 0; }
// A literal WITH a length field keeps its value, including values ToLength would clamp.
export function t4(): number { const xs: any[] = []; xs.push({ length: 5, a: 1 }); const e: any = xs[0]; return e.length; }
export function t5(): number { const xs: any[] = []; xs.push({ length: -2.5 }); const e: any = xs[0]; return e.length; }
export function t6(): number { const xs: any[] = []; xs.push({ length: "abc" }); const e: any = xs[0]; return e.length === "abc" ? 1 : 0; }
// Arrays keep their length (the vec carrier is not a user struct).
export function t7(): number { const xs: any[] = []; xs.push([1, 2, 3]); const e: any = xs[0]; return e.length; }
// An expando length on a closed literal.
export function t8(): number { const xs: any[] = []; xs.push({ type: "A" }); const e: any = xs[0]; e.length = 3; return e.length; }
class Plain { x = 1; }
class Getter { get length(): number { return 42; } }
class Field { length = 7; }
class Sub extends Plain { length = 9; }
// Class instances: absent, getter, own field, subclass field.
export function t9(): number { const e: any = new Plain(); return typeof e.length === "undefined" ? 1 : 0; }
export function t10(): number { const e: any = new Getter(); return e.length; }
export function t11(): number { const e: any = new Field(); return e.length; }
export function t12(): number { const e: any = new Sub(); return e.length; }
`;

/** Node's answers for READS. */
const READS_EXPECTED = {
  t1: 0,
  t2: 1,
  t3: 0,
  t4: 5,
  t5: -2.5,
  t6: 1,
  t7: 3,
  t8: 3,
  t9: 1,
  t10: 42,
  t11: 7,
  t12: 9,
};

/**
 * The upstream assertion harness's deep equality (`toEqual`) over object
 * literals reached through a pushed `any[]`. Before the fix the pushed literal
 * read `length === 0` and took the array-like branch against a `$Object`
 * expected value, so the first test failed. Anti-vacuity: the second and third
 * tests must still FAIL (a toEqual that stopped comparing would pass them), and
 * the fourth (arrays) passes before and after.
 */
const TO_EQUAL_SUITE = `${UPSTREAM_TEST_SHIM}
test("toEqual over equal pushed literals", () => {
  const xs: any[] = [];
  xs.push({ type: "A" });
  expect(xs).toEqual([{ type: "A" }]);
});
test("toEqual sees a differing value", () => {
  const xs: any[] = [];
  xs.push({ type: "A" });
  expect(xs).toEqual([{ type: "B" }]);
});
test("toEqual sees a missing key", () => {
  const xs: any[] = [];
  xs.push({ type: "A", extra: 1 });
  expect(xs).toEqual([{ type: "A" }]);
});
test("toEqual over equal arrays", () => {
  const xs: any[] = [];
  xs.push([1, 2]);
  expect(xs).toEqual([[1, 2]]);
});
${UPSTREAM_TEST_EXPORTS}
${UPSTREAM_TEST_STANDALONE_EXPORTS}`;

describe("#7017 standalone `.length` on an any user-struct receiver is the real Get", () => {
  it("absent lengths read undefined; present fields, getters and expandos keep their value", async () => {
    expect(await runStandalone(READS)).toEqual(READS_EXPECTED);
  }, 300_000);

  it("the upstream harness's toEqual compares pushed object literals by content", async () => {
    const result = await compile(TO_EQUAL_SUITE, {
      fileName: "to-equal.ts",
      skipSemanticDiagnostics: true,
      deferTopLevelInit: true,
      ...STANDALONE_COMPILE_OVERRIDES,
    });
    expect(result.success, JSON.stringify(result.errors?.slice(0, 3))).toBe(true);
    const instance = await instantiateStandaloneResult(result);
    (instance.exports.__module_init as (() => void) | undefined)?.(); // deferTopLevelInit
    const run = runStandaloneUpstreamTests(instance);
    expect(run.statuses, JSON.stringify(run.errors)).toEqual([true, false, false, true]);
    expect(run.errors[1]).toContain("toEqual mismatch");
    expect(run.errors[2]).toContain("toEqual mismatch");
  }, 300_000);
});
