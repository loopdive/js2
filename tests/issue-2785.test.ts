// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2785 — Type-aware box primitive: the box helper at `coerceType(i32 →
// externref)` is chosen by the value's BRAND (its TS type), never by the bare
// Wasm kind. `i32` is overloaded (number / boolean / symbol-handle), so a
// type-blind `__box_number` turns a boolean `true` (i32 1) into the number 1 and
// a symbol handle into a number — the root cause of the two R1 merge_group parks
// (#2760/#2766) and F1's f64-only narrowing.
//
// End-to-end proof: the plain-array OOB→`undefined` floor (F1) is RE-ENABLED for
// `boolean[]` — the in-bounds element is now boxed via `__box_boolean`, so a
// boolean read survives boxing value-correct (=== true / false) and an OOB read
// returns JS `undefined`. `number[]` stays on `__box_number` (unchanged);
// `symbol[]` is deferred (no native standalone `__box_symbol` yet) and falls
// through to the unchanged shared-helper read — keeping the `symbols-omitted`
// canary green.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// Host-mode harness (buildImports + setExports — the canonical host runtime glue
// so a newly-imported helper can never be silently masked).
async function run(source: string, fn = "test"): Promise<unknown> {
  const result = await compile(source);
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn]();
}

// Standalone harness (empty imports `{}` — a leaked host import fails
// instantiation; the binary must be valid Wasm). Standalone conflates
// `undefined` with `null`, so `=== undefined` is satisfied by the native
// `ref.null.extern` OOB sentinel. The boolean box is the native
// `__box_boolean_struct`, classified as a BOOLEAN (not a number) by
// `__any_from_extern`, so `boxedBool === true` is value-correct.
async function runStandalone(source: string, fn = "test"): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>)[fn]() as number;
}

describe("#2785 — type-aware box primitive (box keyed on the TS type, not the Wasm kind)", () => {
  describe("boolean[] OOB → JS `undefined` (the re-enabled #2766-deferred arm)", () => {
    it("host: a[OOB] === undefined (literal index past end)", async () => {
      expect(
        await run(`export function test(): boolean { const a: boolean[] = [true, false]; return a[4] === undefined; }`),
      ).toBe(1);
    });

    it("host: a[OOB] surfaces to JS as undefined (NOT the number 1 / false)", async () => {
      // `__box_number` would have boxed the in-bounds value as a number, but the
      // OOB read is `undefined` regardless; this asserts the value identity.
      expect(
        await run(`export function test(): any { const a: boolean[] = [true, false]; let i = 7; return a[i]; }`),
      ).toBe(undefined);
    });

    it("host: dynamic OOB index reads undefined", async () => {
      expect(
        await run(
          `export function test(): boolean { const a: boolean[] = [true, false]; let i = 9; return a[i] === undefined; }`,
        ),
      ).toBe(1);
    });

    it("host: negative index reads undefined", async () => {
      expect(
        await run(
          `export function test(): boolean { const a: boolean[] = [true, false]; return a[-1] === undefined; }`,
        ),
      ).toBe(1);
    });

    it("standalone: a[OOB] === undefined (undefined ≡ null)", async () => {
      expect(
        await runStandalone(
          `export function test(): boolean { const a: boolean[] = [true, false]; let i = 7; return a[i] === undefined; }`,
        ),
      ).toBe(1);
    });
  });

  describe("boolean[] in-bounds box preserves the boolean TAG (=== true / false)", () => {
    it("host: a[i] === true (dynamic index → boxed via __box_boolean)", async () => {
      expect(
        await run(
          `export function test(): boolean { const a: boolean[] = [true, false]; let i = 0; return a[i] === true; }`,
        ),
      ).toBe(1);
    });

    it("host: a[i] === false (boxed false is a boolean, not the number 0)", async () => {
      expect(
        await run(
          `export function test(): boolean { const a: boolean[] = [true, false]; let i = 1; return a[i] === false; }`,
        ),
      ).toBe(1);
    });

    it("standalone: a[i] === true (native __box_boolean_struct is boolean-tagged)", async () => {
      // The exact failure mode of the second R1 park: `__box_number` tagged it a
      // number and `1 !== true`. `__box_boolean` tags it a boolean → holds.
      expect(
        await runStandalone(
          `export function test(): boolean { const a: boolean[] = [true, false]; let i = 0; return a[i] === true; }`,
        ),
      ).toBe(1);
    });

    it("standalone: a[i] === false", async () => {
      expect(
        await runStandalone(
          `export function test(): boolean { const a: boolean[] = [true, false]; let i = 1; return a[i] === false; }`,
        ),
      ).toBe(1);
    });
  });

  describe("boolean round-trip: box → externref → consume", () => {
    it("host: boxed boolean used as a condition (in-bounds true → branch taken)", async () => {
      expect(
        await run(
          `export function test(): number { const a: boolean[] = [true, false]; let i = 0; if (a[i]) { return 10; } return 20; }`,
        ),
      ).toBe(10);
    });

    it("standalone: boxed boolean used as a condition", async () => {
      expect(
        await runStandalone(
          `export function test(): number { const a: boolean[] = [true, false]; let i = 1; if (a[i]) { return 10; } return 20; }`,
        ),
      ).toBe(20);
    });
  });

  describe("number[] regression guard — F1 unchanged for f64 (still __box_number)", () => {
    it("host: number[] OOB === undefined", async () => {
      expect(
        await run(`export function test(): boolean { const a: number[] = [1, 4, 5]; return a[4] === undefined; }`),
      ).toBe(1);
    });

    it("host: number[] in-bounds read round-trips through arithmetic", async () => {
      expect(
        await run(`export function test(): number { const a: number[] = [1, 4, 5]; let i = 1; return a[i] + 10; }`),
      ).toBe(14);
    });

    it("standalone: number[] OOB === undefined", async () => {
      expect(
        await runStandalone(
          `export function test(): boolean { const a: number[] = [1, 4, 5]; let i = 9; return a[i] === undefined; }`,
        ),
      ).toBe(1);
    });

    it("host: Math.pow with array element arg stays unboxed (numeric-hint guard)", async () => {
      expect(
        await run(`export function test(): number { const b: number[] = [2, 7]; return Math.pow(b[0], 3); }`),
      ).toBe(8);
    });
  });

  describe("canaries — the two R1 parks MUST stay green", () => {
    it("symbols-omitted: Object.values({k: sym})[0] === sym (symbol deferred, not mis-boxed) — host", async () => {
      expect(
        await run(
          `export function test(): boolean { const s = Symbol("v"); const o: any = { key: s }; const r = Object.values(o); return r.length === 1 && r[0] === s; }`,
        ),
      ).toBe(1);
    });

    it("symbols-omitted — standalone", async () => {
      expect(
        await runStandalone(
          `export function test(): boolean { const s = Symbol("v"); const o: any = { key: s }; const r = Object.values(o); return r.length === 1 && r[0] === s; }`,
        ),
      ).toBe(1);
    });

    it("boolean map: result reads are true/false, not numbers — host", async () => {
      expect(
        await run(
          `export function test(): boolean { const r = [1, -1, 2].map((x: number) => x > 0); return r[0] === true && r[1] === false && r[2] === true; }`,
        ),
      ).toBe(1);
    });

    it("boolean map: result reads are true/false in STANDALONE (the regressed lane)", async () => {
      expect(
        await runStandalone(
          `export function test(): boolean { const r = [1, -1, 2].map((x: number) => x > 0); return r[0] === true && r[1] === false && r[2] === true; }`,
        ),
      ).toBe(1);
    });

    it("map-on-array-like (15.4.4.19-8-b-2): testResult[2] === false — externref OOB unchanged (host)", async () => {
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
});
