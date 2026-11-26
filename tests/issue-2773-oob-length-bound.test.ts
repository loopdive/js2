// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2773 S7 — externref plain-array OOB → `undefined` + length-bounded vec reads
// + grow-write gap-fill.
//
// Three coupled defects broke the test262 HOF "-c-ii-5" family
// (`every/some/map/forEach/filter/reduce/reduceRight` "callbackfn called with
// correct parameters" tracking-array variants):
//
//   1. An OOB read of an EXTERNREF-element plain array (`var k = []` — TS
//      `never[]`/`any[]`) produced `ref.null.extern`, so `typeof k[i]` reported
//      "object" and `k[i] === undefined` was false. The F1 OOB→undefined floor
//      (#2760/#2785/#2792) covered f64/boolean/symbol elements but DEFERRED
//      externref. Fixed by opting the two `compileElementAccessBody` plain-array
//      call sites into the #1396 `useUndefinedSentinel` arm of
//      `emitBoundsCheckedArrayGet` (shared default untouched).
//   2. The unproven vec read bounded by the BACKING-ARRAY CAPACITY
//      (`array.len(data)`), not the vec's logical `length` field. A grow
//      (`k[0]=1` on `[]` over-allocates capacity 4) or a `pop` leaves
//      length < capacity, and indices in [length, capacity) silently read the
//      element default / a stale popped slot instead of being OOB. Fixed by
//      threading a `[local.get vecRef, struct.get length]` bound into the
//      bounded-read helpers at the vec-struct call site.
//   3. An index-grow write PAST the length (`kIndex[3]=1` on an empty array —
//      the reduceRight downward variant) left [oldLength, idx) holding nulls
//      that became in-bounds once length bumped to idx+1. Fixed by
//      `array.fill`-ing the gap with JS `undefined` (externref elements only;
//      true $Hole fidelity is #2001 S2/S3).

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

async function run(source: string, fn = "run"): Promise<unknown> {
  const result = await compile(source, { skipSemanticDiagnostics: true });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const instance = await instantiateWithRuntime(result);
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn]();
}

describe("#2773 S7 — externref OOB → undefined, length-bounded reads, gap-fill", () => {
  it("typeof k[i] on an empty captured [] is 'undefined' (dynamic any index)", async () => {
    const r = await run(`
      var k = [];
      var r = "";
      function cb(val, idx, obj) {
        if (idx === 0) r = typeof k[idx];
      }
      export function run(): string {
        [5].forEach(cb);
        return r;
      }
    `);
    expect(r).toBe("undefined");
  });

  it("the -c-ii-5 upward tracking pattern (map)", async () => {
    const r = await run(`
      var kIndex = [];
      function callbackfn(val, idx, obj) {
        if (typeof kIndex[idx] === "undefined") {
          if (idx !== 0 && typeof kIndex[idx - 1] === "undefined") return true;
          kIndex[idx] = 1;
          return false;
        }
        return true;
      }
      export function run(): string {
        var t = [11, 12, 13, 14].map(callbackfn);
        return "" + t[0] + t[1] + t[2] + t[3];
      }
    `);
    expect(r).toBe("falsefalsefalsefalse");
  });

  it("the reduceRight DOWNWARD tracking pattern (grow-write gap reads undefined)", async () => {
    const r = await run(`
      var arr = [11, 12, 13, 14];
      var kIndex = [];
      var result = true;
      function callbackfn(preVal, curVal, idx, o) {
        if (typeof kIndex[idx] === "undefined") {
          if (idx !== arr.length - 1 && typeof kIndex[idx + 1] === "undefined") result = false;
          kIndex[idx] = 1;
        } else {
          result = false;
        }
      }
      export function run(): boolean {
        arr.reduceRight(callbackfn, 1);
        return result;
      }
    `);
    expect(r).toBe(1);
  });

  it("index-grow write past length: middle gap reads undefined, ends correct", async () => {
    const r = await run(`
      export function run(): string {
        var a = [];
        a[3] = "x";
        return a.length + "|" + typeof a[0] + "," + typeof a[1] + "," + typeof a[2] + "," + a[3];
      }
    `);
    expect(r).toBe("4|undefined,undefined,undefined,x");
  });

  it("pop leaves the vacated slot unreadable (stale-slot read → undefined)", async () => {
    // NOTE: `typeof a[2]` on a homogeneous `string[]` is statically FOLDED to
    // "string" without reading (pre-existing fold, orthogonal defect) — so
    // observe via `=== undefined` and via a heterogeneous receiver instead.
    const r = await run(`
      export function run(): string {
        var a = ["p", "q", "r"];
        a.pop();
        return a.length + "|" + (a[2] === undefined ? "U" : "leak") + "|" + a[1];
      }
    `);
    expect(r).toBe("2|U|q");
    const r2 = await run(`
      export function run(): string {
        var a = ["p", 1, "r"];
        a.pop();
        return a.length + "|" + typeof a[2] + "|" + a[1];
      }
    `);
    expect(r2).toBe("2|undefined|1");
  });

  it("k[i] === undefined at OOB on any[] (the filter -c-iii-1-6 shape)", async () => {
    const r = await run(`
      var toIndex = [];
      var ok = true;
      function callbackfn(val, idx, obj) {
        if (toIndex[idx] === undefined) {
          if (idx !== 0 && toIndex[idx - 1] === undefined) ok = false;
          toIndex[idx] = 1;
          return true;
        }
        ok = false;
        return false;
      }
      export function run(): string {
        var newArr = [11, 12, 13, 14].filter(callbackfn);
        return newArr.length + "|" + (ok ? "ok" : "bad");
      }
    `);
    expect(r).toBe("4|ok");
  });

  it("string[] OOB read is undefined (typed source)", async () => {
    const r = await run(`
      export function run(): boolean {
        const a: string[] = ["x"];
        let i = 5;
        return a[i] === undefined;
      }
    `);
    expect(r).toBe(1);
  });

  it("in-bounds reads and length unchanged after sequential grow-writes", async () => {
    const r = await run(`
      var k = [];
      function cb(val, idx, obj) { k[idx] = val * 2; }
      export function run(): string {
        [1, 2, 3].forEach(cb);
        return k.length + "|" + k[0] + "," + k[1] + "," + k[2];
      }
    `);
    expect(r).toBe("3|2,4,6");
  });

  it("numeric-consumer OOB keeps the NaN sentinel path (no externref ripple)", async () => {
    // `a[i] + 1` is a numeric-context read → arm 2 (NaN), never a boxed
    // undefined — the F1 consumer-scoping discipline.
    const r = await run(`
      export function run(): number {
        const a = [10, 20, 30];
        let i = 50;
        return a[i] + 1;
      }
    `);
    expect(r).toBeNaN();
  });

  it("heterogeneous array in-bounds reads keep identity through grow", async () => {
    const r = await run(`
      export function run(): string {
        var a = [];
        a[0] = "s";
        a[1] = 7;
        a[2] = true;
        return "" + a[0] + "," + a[1] + "," + (a[2] === true) + "," + typeof a[3];
      }
    `);
    expect(r).toBe("s,7,true,undefined");
  });

  it("standalone lane still compiles and runs the tracking pattern (null≡undefined convention)", async () => {
    const result = await compile(
      `
      var k = [];
      function cb(val, idx, obj) { k[idx] = val; }
      export function run(): number {
        [4, 5, 6].forEach(cb);
        return k.length;
      }
    `,
      { skipSemanticDiagnostics: true, target: "standalone" },
    );
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(3);
  });
});
