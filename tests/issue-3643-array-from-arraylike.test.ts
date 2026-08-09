// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3643 Slice B — `Array.from` ignored `length` on a WasmGC array-like.
//
// ECMA-262 §23.1.2.1 step 6: when the source is NOT iterable, `Array.from`
// falls back to LengthOfArrayLike + indexed reads. WasmGC structs are opaque to
// JS, so native `Array.from` read `length` as `undefined` and answered `[]` —
// silently dropping every element.
//
// The localising control: `Array.prototype.slice.call` on the IDENTICAL
// receiver was already correct, because it routes through `_wrapForHost` (the
// live-mirror proxy over a WasmGC struct). So the array-like machinery existed
// and only `Array.from`'s non-iterable arm was unwired — the fix reuses that
// proxy rather than re-implementing spec step 6.
//
// Measured on `origin/main` @ e0f1d6e1 (host lane, `runTest262File`). Rows 1-2
// are the filed defect; rows 3-5 are additional shapes that failed the same way
// and were never listed in the issue. Every control was A/B'd against
// unmodified `origin/main` — the iterable-source control passed BEFORE the
// change, so it proves absence of collateral rather than absence of crashes.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(src: string): Promise<Record<string, any>> {
  const result: any = await compile(src, { fileName: "probe.mjs" });
  expect(
    result.success,
    `Compile failed:\n${(result.errors ?? []).map((e: any) => `  L${e.line}: ${e.message}`).join("\n")}`,
  ).toBe(true);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return wrapExports(instance.exports, { signatures: result.exportSignatures });
}

describe("#3643 Slice B — Array.from honours length on a WasmGC array-like", () => {
  it("Array.from({length: 2}) produces two holes, not []", async () => {
    const exports = await run(`
      // @ts-nocheck
      export function len() { return Array.from({ length: 2 }).length; }
      export function elem0IsUndefined() { return Array.from({ length: 2 })[0] === undefined ? 1 : 0; }
    `);
    expect(exports.len()).toBe(2); // was 0
    expect(exports.elem0IsUndefined()).toBe(1);
  });

  it("Array.from({length: 2, 0: 'a', 1: 'b'}) reads the indexed elements", async () => {
    const exports = await run(`
      // @ts-nocheck
      export function len() { return Array.from({ length: 2, 0: "a", 1: "b" }).length; }
      export function joined() { return Array.from({ length: 2, 0: "a", 1: "b" }).join("-"); }
    `);
    expect(exports.len()).toBe(2); // was 0
    expect(exports.joined()).toBe("a-b"); // was ""
  });

  it("Array.from(arrayLike, mapFn) applies the mapper over the array-like", async () => {
    const exports = await run(`
      // @ts-nocheck
      export function mapped() {
        var r = Array.from({ length: 3 }, function (_, i) { return i * 10; });
        return r.length * 1000 + r[0] + r[2];
      }
    `);
    expect(exports.mapped()).toBe(3020); // len 3, r[0] 0, r[2] 20; was 0
  });

  it("length is coerced, and sparse indices become holes", async () => {
    const exports = await run(`
      // @ts-nocheck
      export function coerced() { return Array.from({ length: "2" }).length; }
      export function sparseLen() { return Array.from({ length: 3, 1: "b" }).length; }
      export function sparseFilled() { return Array.from({ length: 3, 1: "b" })[1]; }
      export function sparseHole() { return Array.from({ length: 3, 1: "b" })[0] === undefined ? 1 : 0; }
    `);
    expect(exports.coerced()).toBe(2);
    expect(exports.sparseLen()).toBe(3);
    expect(exports.sparseFilled()).toBe("b");
    expect(exports.sparseHole()).toBe(1);
  });

  it("Array.from now AGREES with slice.call on the identical receiver", async () => {
    // This is the row that localised the defect: the two disagreed only because
    // `slice.call` already went through `_wrapForHost` and `Array.from` did not.
    const exports = await run(`
      // @ts-nocheck
      export function agree() {
        var src = { length: 2, 0: 5, 1: 6 };
        var viaSlice = Array.prototype.slice.call(src);
        var viaFrom = Array.from(src);
        if (viaSlice.length !== viaFrom.length) return 0;
        if (viaSlice[0] !== viaFrom[0]) return 0;
        if (viaSlice[1] !== viaFrom[1]) return 0;
        return viaFrom[1];
      }
    `);
    expect(exports.agree()).toBe(6); // was 0 (lengths disagreed: 2 vs 0)
  });

  // ---- controls: green on origin/main BEFORE the fix, must stay green ----

  it("control — iterable sources still use the iterator path", async () => {
    const exports = await run(`
      // @ts-nocheck
      export function fromArray() { return Array.from([1, 2, 3]).length; }
      export function fromString() { return Array.from("abc").join(""); }
      export function fromSet() { return Array.from(new Set([1, 2])).length; }
      export function fromGenerator() {
        function* g() { yield 5; yield 6; }
        var r = Array.from(g());
        return r.length * 10 + r[1];
      }
      export function fromArrayWithMap() {
        var r = Array.from([1, 2], function (x) { return x * 2; });
        return r[1];
      }
    `);
    expect(exports.fromArray()).toBe(3);
    expect(exports.fromString()).toBe("abc");
    expect(exports.fromSet()).toBe(2);
    expect(exports.fromGenerator()).toBe(26);
    expect(exports.fromArrayWithMap()).toBe(4);
  });

  it("control — an object with NO length still yields an empty array", async () => {
    const exports = await run(`
      // @ts-nocheck
      export function empty() { return Array.from({}).length; }
      export function zero() { return Array.from({ length: 0 }).length; }
    `);
    expect(exports.empty()).toBe(0);
    expect(exports.zero()).toBe(0);
  });

  // RESIDUAL, deliberately NOT asserted as fixed: an object carrying BOTH a
  // `length` and a callable `@@iterator` still answers `[]`. A/B'd against
  // unmodified `origin/main` — it failed there identically, so it is a separate
  // pre-existing gap in the @@iterator-on-a-struct path, not collateral from
  // this change. Recorded in the issue so a later sweep does not read Slice B
  // as covering it.
});
