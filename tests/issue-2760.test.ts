// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2760 — Hybrid type-soundness floor F1: a plain-array out-of-bounds read of a
// PRIMITIVE element (`number[]` f64 / `boolean[]` i32) returns JS `undefined`
// (the SAFE default), not the type-default sentinel (sNaN / 0).
//
// Scope of this F1 slice (see the issue file for the full rationale):
//   - PRIMITIVE element arrays (`number[]`, `boolean[]`) → OOB reads `undefined`.
//   - The unproven (non-bounds-eliminated) read widens to a boxed-or-undefined
//     externref; the proven in-bounds read keeps the unboxed fast path.
//   - The OOB→undefined policy is applied at the `compileElementAccessBody` call
//     sites — the shared `emitBoundsCheckedArrayGet` default is NOT flipped, so
//     the typed-array / `$__subview` / array-method internal callers keep their
//     own OOB semantics (flipping the shared default was the S2 leak, #2198).
//   - EXTERNREF element arrays (`any[]`/`string[]`) OOB→undefined is DEFERRED:
//     it trips the `Array.prototype.map`-on-array-like canary
//     (`built-ins/Array/prototype/map/15.4.4.19-8-b-2.js`) via a pre-existing
//     map-of-plain-object length bug. The canary MUST stay green — guarded below.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

// Host-mode harness (buildImports + setExports — the canonical host runtime glue
// so a newly-imported helper can never be silently masked).
async function run(source: string, fn = "test"): Promise<unknown> {
  const result = await compile(source);
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const instance = await instantiateWithRuntime(result);
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn]();
}

// Standalone harness (empty imports `{}` — a leaked host import fails
// instantiation; the binary must be valid Wasm). Standalone conflates
// `undefined` with `null`, so `=== undefined` is satisfied by the native
// `ref.null.extern` OOB sentinel.
async function runStandalone(source: string, fn = "test"): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>)[fn]() as number;
}

describe("#2760 F1 — plain-array OOB read → JS `undefined` (primitive elements)", () => {
  describe("host — number[] OOB reads undefined", () => {
    it("a[OOB] === undefined (literal index past end)", async () => {
      expect(
        await run(`export function test(): boolean { const a: number[] = [1, 4, 5]; return a[4] === undefined; }`),
      ).toBe(1);
    });

    it("a[OOB] surfaces to JS as undefined, not sNaN/null", async () => {
      expect(await run(`export function test(): any { const a: number[] = [1, 4, 5]; return a[4]; }`)).toBe(undefined);
    });

    it("negative index reads undefined", async () => {
      expect(
        await run(`export function test(): boolean { const a: number[] = [1, 4, 5]; return a[-1] === undefined; }`),
      ).toBe(1);
    });

    it("dynamic OOB index reads undefined", async () => {
      expect(
        await run(
          `export function test(): boolean { const a: number[] = [1, 4, 5]; let i = 7; return a[i] === undefined; }`,
        ),
      ).toBe(1);
    });

    it("OOB read used in arithmetic is NaN (undefined + 1)", async () => {
      // `undefined + 1` is NaN in JS; the widened externref unboxes to NaN.
      expect(
        await run(
          `export function test(): boolean { const a: number[] = [1, 4, 5]; let i = 9; let v = a[i] + 1; return v !== v; }`,
        ),
      ).toBe(1);
    });
  });

  // #2785 — boolean[] OOB→undefined is now RE-ENABLED. The type-aware box keys
  // the box helper on the element's SEMANTIC type (reconstructed from the
  // receiver TS type, since the brand is erased in `arrDef.element`): a
  // `boolean[]` element boxes via `__box_boolean`, not the type-blind
  // `__box_number` that corrupted it (boolean `true` → the number 1). So an OOB
  // boolean[] read now returns JS `undefined` like `number[]`. `symbol[]` stays
  // deferred (no native standalone `__box_symbol` yet) — full coverage in
  // `tests/issue-2785.test.ts`.
  describe("host — boolean[] OOB → undefined (re-enabled by the type-aware box, #2785)", () => {
    it("a[OOB] === undefined (was the type-default `false`, deferred under #2766)", async () => {
      expect(
        await run(`export function test(): boolean { const a: boolean[] = [true, false]; return a[4] === undefined; }`),
      ).toBe(1); // OOB boolean[] read now reads JS undefined (#2785)
    });
  });

  describe("host — in-bounds primitive reads are unchanged", () => {
    it("number[] in-bounds read returns the element", async () => {
      expect(
        await run(`export function test(): number { const a: number[] = [1, 4, 5]; let i = 1; return a[i]; }`),
      ).toBe(4);
    });

    it("number[] in-bounds read round-trips through arithmetic", async () => {
      expect(
        await run(`export function test(): number { const a: number[] = [1, 4, 5]; let i = 1; return a[i] + 10; }`),
      ).toBe(14);
    });

    it("boolean[] in-bounds read preserves the boolean tag (=== true)", async () => {
      expect(
        await run(
          `export function test(): boolean { const a: boolean[] = [true, false]; let i = 0; return a[i] === true; }`,
        ),
      ).toBe(1);
    });

    it("counted-loop sum keeps the unboxed fast path", async () => {
      expect(
        await run(
          `export function test(): number { const a: number[] = [1, 2, 3, 4]; let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; }`,
        ),
      ).toBe(10);
    });
  });

  describe("standalone — primitive OOB reads undefined (undefined≡null), fast path intact", () => {
    it("number[] OOB === undefined", async () => {
      expect(
        await runStandalone(
          `export function test(): boolean { const a: number[] = [1, 4, 5]; return a[4] === undefined; }`,
        ),
      ).toBe(1);
    });

    it("number[] in-bounds read is preserved", async () => {
      expect(
        await runStandalone(
          `export function test(): number { const a: number[] = [1, 4, 5]; let i = 1; return a[i]; }`,
        ),
      ).toBe(4);
    });

    it("counted-loop sum (bounds-eliminated, no host import) is valid Wasm", async () => {
      expect(
        await runStandalone(
          `export function test(): number { const a: number[] = [1, 2, 3, 4]; let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; }`,
        ),
      ).toBe(10);
    });
  });

  describe("typed-array OOB → undefined is now handled separately (#2798 Row 9)", () => {
    it("Int32Array OOB === undefined (was out-of-F1-scope; now widened by #2798)", async () => {
      // #2798 (hybrid audit Row 9) extended the OOB→undefined policy to genuine
      // typed-array VIEWS via a DEDICATED call-site helper
      // (`emitTypedArrayUndefinedOobGet`) — the shared `emitBoundsCheckedArrayGet`
      // default and #2760's `emitPlainArrayUndefinedOobGet` both stay
      // byte-identical. So a typed-array OOB read now reads JS `undefined` like a
      // plain array. Full coverage lives in `tests/issue-2798.test.ts`.
      expect(
        await run(
          `export function test(): boolean { const a = new Int32Array(3); let i = 9; return a[i] === undefined; }`,
        ),
      ).toBe(1);
    });
  });

  describe("S2 canary — Array.prototype.map on an array-like MUST stay green (#2198)", () => {
    // The exact shape of test262 built-ins/Array/prototype/map/15.4.4.19-8-b-2.js.
    // `testResult[2]` is an externref-vec OOB read (the map-of-plain-object result
    // is length 0 — a separate pre-existing bug). It passes only because the
    // externref OOB default surfaces as a falsy value that the assert accepts.
    // F1 deliberately does NOT change externref OOB behaviour, so this stays green.
    it("testResult[2] === false (externref OOB behaviour preserved)", async () => {
      expect(
        await run(`
          export function test(): boolean {
            function callbackfn(val: any, idx: any, obj: any): boolean {
              if (idx === 2 && val === "length") { return false; } else { return true; }
            }
            var obj: any = {};
            Object.defineProperty(obj, "length", {
              get: function () { obj[2] = "length"; return 3; },
              configurable: true,
            });
            var testResult = Array.prototype.map.call(obj, callbackfn);
            return testResult[2] === false;
          }
        `),
      ).toBe(1);
    });
  });

  describe("numeric-context regression guard — Math.* with array element args", () => {
    // The first cut widened every unproven primitive read to externref, which
    // broke `Math.pow`/`max`/`hypot` (the numeric caller captures `Math_pow`'s
    // funcIdx before compiling args; the widening's late import shifted it →
    // invalid wasm). The numeric-hint suppression keeps these unboxed.
    it("Math.pow with array element arg (number[]) is valid and correct", async () => {
      expect(
        await run(`export function test(): number { const b: number[] = [2, 7]; return Math.pow(b[0], 3); }`),
      ).toBe(8);
    });

    it("Math.pow with new Array() element arg (evolving number[])", async () => {
      expect(
        await run(`export function test(): number { var b = new Array(); b[0] = 2; return Math.pow(b[0], 3); }`),
      ).toBe(8);
    });

    it("Math.max with two array element args", async () => {
      expect(
        await run(`export function test(): number { const a: number[] = [3, 5]; return Math.max(a[0], a[1]); }`),
      ).toBe(5);
    });

    it("OOB element in a numeric context coerces to NaN (undefined → ToNumber)", async () => {
      // In a numeric context `a[OOB]` is unobservable as undefined; it coerces to
      // NaN, which is the JS-correct `Math.pow(undefined, 3)` result.
      expect(
        await run(
          `export function test(): boolean { const a: number[] = [2]; let i = 9; let v = Math.pow(a[i], 3); return v !== v; }`,
        ),
      ).toBe(1);
    });
  });
});
