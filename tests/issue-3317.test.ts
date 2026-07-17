import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

// #3317 — standalone Array.prototype.{indexOf,lastIndexOf,includes}:
// ToNumber-of-object length coercion + abrupt length reads.
//
// Three fixes under test:
//  1. (object-runtime.ts fillExternArrayLikeStructArms) a CLOSED-STRUCT
//     receiver whose `length` field is an OBJECT now runs the observable
//     §7.1.20 ToLength(ToNumber(ToPrimitive(v, number))) walk via
//     `__to_primitive` — valueOf→toString ordering, string-result
//     StringToNumber, abrupt-throw propagation, both-objects TypeError.
//  2. (array-prototype-borrow.ts compileArrayPrototypeCall) the corpus
//     spelling `[].includes.call(obj, x)` (empty array literal borrow) routes
//     through the same generic borrow compiler as `Array.prototype.includes
//     .call(obj, x)` under standalone, instead of the generic member path
//     that cast the borrowed receiver to the literal's vec type and trapped.
//  3. (compileArrayLikePrototypeCall/Search) standalone search borrows no
//     longer bail to the host `__proto_method_call` bridge inside
//     assert_throws, and the no-search-arg form (`indexOf.call(obj)`) still
//     runs the observable length coercion (§23.1.3 step 2 precedes any
//     element access).
//
// Corpus tests flipped by these fixes (verified by direct runTest262File):
//   indexOf/15.4.4.14-3-{19,20,21,22}.js, lastIndexOf/15.4.4.15-3-{19,20,21,22}.js,
//   includes/return-abrupt-get-length.js, includes/return-abrupt-tonumber-length.js

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" } as never);
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): unknown }).test();
}

describe("#3317 standalone search-method ToNumber-of-object length", () => {
  it("object length with toString coerces via StringToNumber (indexOf)", async () => {
    expect(
      await runStandalone(`
        var obj = { 1: true, 2: 2, length: { toString: function() { return '2'; } } };
        export function test(): number {
          return Array.prototype.indexOf.call(obj as any, true) as number;
        }`),
    ).toBe(1);
  });

  it("object length limits the scan (index 2 unreachable when length is 2)", async () => {
    expect(
      await runStandalone(`
        var obj = { 1: true, 2: 2, length: { toString: function() { return '2'; } } };
        export function test(): number {
          return Array.prototype.indexOf.call(obj as any, 2) as number;
        }`),
    ).toBe(-1);
  });

  it("object length with valueOf coerces (lastIndexOf)", async () => {
    expect(
      await runStandalone(`
        var obj = { 1: true, 2: 2, length: { valueOf: function() { return 2; } } };
        export function test(): number {
          return Array.prototype.lastIndexOf.call(obj as any, true) as number;
        }`),
    ).toBe(1);
  });

  it("valueOf runs before toString for the number hint (§7.1.1.1 ordering)", async () => {
    // valueOf answers 2 → length 2 → true found at 1. If toString ('3') won,
    // index 2 (value 2) would be scanned and indexOf(2) would return 2.
    expect(
      await runStandalone(`
        var obj = {
          1: true, 2: 2,
          length: {
            valueOf: function() { return 2; },
            toString: function() { return '3'; }
          }
        };
        export function test(): number {
          return Array.prototype.indexOf.call(obj as any, 2) as number;
        }`),
    ).toBe(-1);
  });

  it("throwing valueOf on length propagates out of the borrow (catchable)", async () => {
    expect(
      await runStandalone(`
        var obj = { 1: true, length: { valueOf: function(): any { throw new Error('boom'); } } };
        export function test(): number {
          try {
            Array.prototype.indexOf.call(obj as any, true);
            return 0;
          } catch (e) {
            return 1;
          }
        }`),
    ).toBe(1);
  });

  it("both valueOf and toString returning objects throws TypeError (§7.1.1.1 step 6)", async () => {
    expect(
      await runStandalone(`
        var obj = {
          1: true,
          length: {
            valueOf: function(): any { return {}; },
            toString: function(): any { return {}; }
          }
        };
        export function test(): number {
          try {
            Array.prototype.indexOf.call(obj as any, true);
            return 0;
          } catch (e) {
            return 1;
          }
        }`),
    ).toBe(1);
  });

  it("no-search-arg form still runs the observable length coercion (indexOf.call(obj))", async () => {
    expect(
      await runStandalone(`
        var obj = { 1: true, length: { valueOf: function(): any { throw new Error('boom'); } } };
        export function test(): number {
          try {
            (Array.prototype.indexOf as any).call(obj);
            return 0;
          } catch (e) {
            return 1;
          }
        }`),
    ).toBe(1);
  });
});

describe("#3317 standalone [].method.call borrow routing", () => {
  it("[].includes.call over a data-length receiver no longer traps", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          var obj: any = { 0: 7, length: 1 };
          return ([] as any[]).includes.call(obj, 7) ? 1 : 2;
        }`),
    ).toBe(1);
  });

  it("[].indexOf.call finds elements on a closed-struct receiver", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          var obj: any = { 0: 7, 1: 9, length: 2 };
          return ([] as any[]).indexOf.call(obj, 9) as number;
        }`),
    ).toBe(1);
  });

  it("[].includes.call with a throwing accessor length getter propagates", async () => {
    expect(
      await runStandalone(`
        function Test262Error(this: any, m?: any) { (this as any).message = m; }
        var obj = {};
        Object.defineProperty(obj, "length", {
          get: function() { throw new (Test262Error as any)(); }
        });
        export function test(): number {
          try {
            ([] as any[]).includes.call(obj, 7);
            return 0;
          } catch (e) {
            return 1;
          }
        }`),
    ).toBe(1);
  });

  it("[].includes.call over a real array receiver still reshapes to the native path", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          var a = [10, 20, 30];
          return ([] as any[]).includes.call(a, 20) ? 1 : 2;
        }`),
    ).toBe(1);
  });
});
