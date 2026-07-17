/**
 * #3201 — array-like `.call` receivers with an INHERITED `length`.
 *
 * `__extern_length`'s struct arm used a raw `__sget_length` try/catch probe.
 * On a fnctor instance struct whose shape happens to cast-succeed for some
 * registered `__sget_length` getter, the probe "succeeds" reading a
 * zero-initialized unrelated slot and returns own length 0 — SHADOWING the
 * inherited `length` on the ctor prototype that `_fnctorProtoLookup`
 * resolves correctly (§7.3.2 Get is prototype-inclusive). Covers the
 * test262 `built-ins/Array/prototype/{indexOf,lastIndexOf}/15.4.4.1[45]-2-*`
 * inherited-length clusters.
 *
 * Fix: resolve own `length` through the #1629-safe `_readOwnDescriptor`
 * (vec live length / sidecar / shape-gated struct field) — never a raw
 * `__sget_*` probe — then fall to the fnctor prototype chain.
 */
import { describe, expect, it } from "vitest";
import { compileAndInstantiate } from "../src/runtime-instantiate";

describe("#3201 array-like .call with inherited length", () => {
  it("indexOf.call finds an own element under an inherited length (15.4.4.14-2-6)", async () => {
    const exports = await compileAndInstantiate(`
      var proto = { length: 2 };
      var Con = function() {};
      Con.prototype = proto;

      var childOne = new Con();
      childOne[1] = true;
      var childTwo = new Con();
      childTwo[2] = true;

      export function foundInRange(): number {
        return Array.prototype.indexOf.call(childOne, true);
      }
      export function beyondLength(): number {
        return Array.prototype.indexOf.call(childTwo, true);
      }
    `);
    // childOne[1] is within the inherited length 2 → found at 1.
    expect((exports.foundInRange as () => number)()).toBe(1);
    // childTwo[2] is beyond the inherited length 2 → not visited → -1.
    expect((exports.beyondLength as () => number)()).toBe(-1);
  });

  it("lastIndexOf.call honours the inherited length (15.4.4.15-2-6 shape)", async () => {
    const exports = await compileAndInstantiate(`
      var proto = { length: 2 };
      var Con = function() {};
      Con.prototype = proto;

      var child = new Con();
      child[1] = "x";

      export function test(): number {
        return Array.prototype.lastIndexOf.call(child, "x");
      }
    `);
    expect((exports.test as () => number)()).toBe(1);
  });

  it("own length still shadows the inherited one", async () => {
    const exports = await compileAndInstantiate(`
      var proto = { length: 0 };
      var Con = function() {};
      Con.prototype = proto;

      var child = new Con();
      child.length = 2;
      child[1] = true;

      export function test(): number {
        return Array.prototype.indexOf.call(child, true);
      }
    `);
    // Own length 2 (sidecar) shadows inherited 0 → element visible.
    expect((exports.test as () => number)()).toBe(1);
  });

  it("real-array receivers keep their live length (no _readOwnDescriptor regression)", async () => {
    const exports = await compileAndInstantiate(`
      var arr = [10, 20, 30];
      export function test(): number {
        return Array.prototype.indexOf.call(arr, 30);
      }
    `);
    expect((exports.test as () => number)()).toBe(2);
  });

  it("plain object-literal receivers with own length keep working", async () => {
    const exports = await compileAndInstantiate(`
      var obj = { 0: 5, 1: 7, length: 2 };
      export function test(): number {
        return Array.prototype.indexOf.call(obj, 7);
      }
    `);
    expect((exports.test as () => number)()).toBe(1);
  });
});

describe("#3201 len==0 checked before ToInteger(fromIndex) (§23.1.3.14/.20 step 3)", () => {
  it("indexOf on an empty array does not observe fromIndex.valueOf", async () => {
    const exports = await compileAndInstantiate(`
      var observed = false;
      var fromIndex: any = {
        valueOf: function(): number { observed = true; return 0; }
      };
      export function test(): number {
        var e: number[] = [];
        var r = e.indexOf(2, fromIndex);
        if (r !== -1) return 100;
        if (observed) return 200;
        return 0;
      }
    `);
    expect((exports.test as () => number)()).toBe(0);
  });

  it("lastIndexOf on an empty array does not observe fromIndex.valueOf", async () => {
    const exports = await compileAndInstantiate(`
      var observed = false;
      var fromIndex: any = {
        valueOf: function(): number { observed = true; return 0; }
      };
      export function test(): number {
        var e: number[] = [];
        var r = e.lastIndexOf(2, fromIndex);
        if (r !== -1) return 100;
        if (observed) return 200;
        return 0;
      }
    `);
    expect((exports.test as () => number)()).toBe(0);
  });

  it("fromIndex.valueOf IS observed on a non-empty array", async () => {
    const exports = await compileAndInstantiate(`
      var observed = false;
      var fromIndex: any = {
        valueOf: function(): number { observed = true; return 1; }
      };
      export function test(): number {
        var a = [7, 8, 8];
        var r = a.indexOf(8, fromIndex);
        if (r !== 1) return 100 + r;
        if (!observed) return 200;
        var r2 = a.lastIndexOf(8, fromIndex);
        if (r2 !== 1) return 300 + r2;
        return 0;
      }
    `);
    expect((exports.test as () => number)()).toBe(0);
  });
});
