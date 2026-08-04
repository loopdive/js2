// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4119 arm 1) The reflective `Object.prototype.toString` classifier in
 * `--target standalone` — §20.1.3.6 / ES5 §15.2.4.2.
 *
 * The 76 official standalone rows this arm targets are the ES5
 * `built-ins/Array/prototype/{slice,splice}` genericity families, which assert
 * `[object Array]` through a STORED method rather than a direct call:
 *
 * ```js
 * arr.getClass = Object.prototype.toString;
 * if (arr.getClass() !== "[object " + "Array" + "]") { … }
 * ```
 *
 * Two hazards these tests are written to defend against:
 *
 *  1. **The static fold must not be what is measured.** #2501's
 *     `resolveObjectToStringTag` folds `Object.prototype.toString.call(v)` at
 *     COMPILE time from the receiver's TS type. Every assertion below routes the
 *     method through an `any`-typed binding first, so the fold cannot key on the
 *     receiver and the RUNTIME classifier is what answers. `staticFoldControl`
 *     pins the fold itself so a regression there is attributed correctly rather
 *     than silently covering for a broken runtime path.
 *  2. **Loud must stay loud.** The classifier is deliberately partial. The
 *     shapes it cannot prove (Date / Error / RegExp / nominal class instances)
 *     must keep THROWING, not fall back to `[object Object]`. A test that only
 *     checked the happy path would let a future "simplification" widen the last
 *     arm into a silent mis-tag, which the acceptance bar counts as negative
 *     value. Those refusals are asserted explicitly below.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile + run `test()` in standalone; returns its number result. */
async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone", hostBridge: "always" });
  expect(r.success, r.success ? undefined : r.errors?.[0]?.message).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports.test as () => number)();
}

/**
 * Drives the classifier through the REFLECTIVE path: the method is stashed in
 * an `any` binding, then `.call`-ed with `recv`. Returns 1 when the tag matches
 * `expected`, 0 on a wrong tag, -1 when the call threw.
 */
const reflective = (setup: string, expected: string) => `
export function test(): number {
  ${setup}
  var g: any = Object.prototype.toString;
  try {
    var res: any = g.call(r);
    return res === ${JSON.stringify(expected)} ? 1 : 0;
  } catch (e: any) { return -1; }
}`;

/** The literal test262 idiom: assign the method onto the receiver, call later. */
const storedOnReceiver = (setup: string, expected: string) => `
export function test(): number {
  ${setup}
  try {
    r.getClass = Object.prototype.toString;
    var res: any = r.getClass();
    return res === ${JSON.stringify(expected)} ? 1 : 0;
  } catch (e: any) { return -1; }
}`;

describe("#4119 arm 1 — reflective Object.prototype.toString (standalone)", () => {
  describe("tags the classifier proves", () => {
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ["array literal", `var r: any = [1,2,3];`, "[object Array]"],
      ["array built at runtime", `var r: any = []; r.push(1);`, "[object Array]"],
      ["string primitive", `var r: any = "ab"; r = r + "c";`, "[object String]"],
      ["number primitive", `var r: any = 1; r = r + 1;`, "[object Number]"],
      ["boolean primitive", `var r: any = true;`, "[object Boolean]"],
      ["null", `var r: any = null;`, "[object Null]"],
      ["undefined", `var r: any = undefined;`, "[object Undefined]"],
      ["function declaration", `function f(){return 1;} var r: any = f;`, "[object Function]"],
      ["arrow function", `var r: any = (x: number) => x;`, "[object Function]"],
      ["object literal", `var r: any = {a:1};`, "[object Object]"],
      ["reified builtin constructor", `var r: any = Array;`, "[object Function]"],
    ];
    for (const [name, setup, expected] of cases) {
      it(`${name} → ${expected}`, async () => {
        expect(await runStandalone(reflective(setup, expected))).toBe(1);
      });
    }
  });

  describe("loud stays loud — unprovable receivers keep THROWING, never mis-tag", () => {
    // Each of these must return -1 (threw). A return of 0 would mean the
    // classifier answered with a wrong tag, and 1 would mean it grew an arm
    // without this test being updated — both are failures worth catching.
    const refusals: ReadonlyArray<readonly [string, string]> = [
      ["Date instance", `var r: any = new Date(0);`],
      ["Error instance", `var r: any = new Error("x");`],
      ["RegExp instance", `var r: any = /a/;`],
      ["nominal class instance", `class K { x = 1; } var r: any = new K();`],
    ];
    for (const [name, setup] of refusals) {
      it(`${name} refuses loudly rather than answering [object Object]`, async () => {
        expect(await runStandalone(reflective(setup, "[object Object]"))).toBe(-1);
      });
    }
  });

  describe("the literal test262 idiom (method stored on the receiver)", () => {
    // This is the shape the ES5 S15.4.4.10_A* / S15.4.4.12_A* families use.
    it("array receiver → [object Array]", async () => {
      expect(await runStandalone(storedOnReceiver(`var r: any = [1,2,3];`, "[object Array]"))).toBe(1);
    });
    it("array built at runtime → [object Array]", async () => {
      expect(await runStandalone(storedOnReceiver(`var r: any = []; r.push(7);`, "[object Array]"))).toBe(1);
    });
    it("object literal → [object Object]", async () => {
      expect(await runStandalone(storedOnReceiver(`var r: any = {a:1};`, "[object Object]"))).toBe(1);
    });
    it("function → [object Function]", async () => {
      expect(
        await runStandalone(storedOnReceiver(`function f(){return 1;} var r: any = f;`, "[object Function]")),
      ).toBe(1);
    });
  });

  describe("attribution controls", () => {
    it("staticFoldControl: #2501's compile-time fold still answers the direct .call form", async () => {
      // Pins the OTHER path. If this breaks, the regression is #2501's fold, not
      // the runtime classifier — and if the runtime classifier ever breaks, this
      // staying green proves the two paths are genuinely independent.
      expect(
        await runStandalone(`
export function test(): number {
  var s: any = Object.prototype.toString.call([1,2]);
  return s === "[object Array]" ? 1 : 0;
}`),
      ).toBe(1);
    });

    it("the tag is computed at RUNTIME, not folded from the receiver's static type", async () => {
      // `pick` hides which value comes back, so no static type can name the
      // receiver — the answer can only come from the runtime `ref.test` chain.
      expect(
        await runStandalone(`
function pick(n: number): any { return n > 0 ? [1] : {a: 1}; }
export function test(): number {
  var g: any = Object.prototype.toString;
  var a: any = g.call(pick(1));
  var b: any = g.call(pick(-1));
  return (a === "[object Array]" && b === "[object Object]") ? 1 : 0;
}`),
      ).toBe(1);
    });
  });
});
