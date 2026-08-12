// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2766 — Hybrid IR step 1: ElementAccess prove-then-specialize.
//
// The IR element read (`src/ir/from-ast.ts` `lowerElementAccess` → `emitVecGet`)
// used to emit an UNCHECKED `array.get` that TRAPS on an out-of-bounds index —
// the sharpest hybrid-invariant violation (strictly worse than legacy, which at
// least bounds-checks). This change makes it prove-then-specialize:
//   - FAST: index PROVEN in `[0, length)` (counted-loop proof ported from legacy
//     `safeIndexedArrays`) → keep the unchecked `vec.get` (no perf regression).
//   - SAFE: index NOT proven → bounds-checked read that returns the JS-correct
//     OOB value (NaN for `number[]`, never a trap) — the IR counterpart of
//     #2760's legacy floor F1.
//
// Folds in #2760 (R1, legacy floor) — see tests/issue-2760.test.ts for the
// legacy-path OOB→undefined coverage. This file covers the IR-path behavior.

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
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn]();
}

// Compile + return both the run() value and the demotion list + the exported
// function's WAT body, so we can assert the FAST/SAFE structural choice.
function extractFunc(wat: string, name: string): string {
  const idx = wat.indexOf(`(func $${name} `);
  if (idx < 0) return "";
  let depth = 0;
  let i = idx;
  for (; i < wat.length; i++) {
    if (wat[i] === "(") depth++;
    else if (wat[i] === ")") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  return wat.slice(idx, i);
}
async function compileInfo(source: string, fn: string) {
  const r = await compile(source, { trackIrOutcomes: true });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const body = extractFunc(r.wat, fn);
  // A structured `if` (the SAFE bounds-check) vs `br_if` (ordinary loop branch).
  const hasStructuredIf = /\bif\b/.test(body.replace(/br_if/g, "BRIF"));
  return {
    demotions: (r.irPostClaimErrors ?? []).length,
    hasStructuredIf,
    body,
    outcome: r.irOutcomes?.find((candidate) => candidate.displayName === fn),
  };
}

describe("#2766 — IR ElementAccess prove-then-specialize", () => {
  describe("SAFE path — out-of-bounds reads no longer trap", () => {
    it("OOB dynamic numeric read returns NaN (was a Wasm trap)", async () => {
      // i is a plain local, not a counted-loop induction var → not proven →
      // SAFE bounds-checked read. JS `a[99]` is undefined; in this numeric
      // (f64) context `ToNumber(undefined)` is NaN.
      expect(
        await run(`export function test(): number { const a = [10, 20, 30]; let i = 99; return a[i]; }`),
      ).toBeNaN();
    });

    it("negative dynamic index returns NaN (no trap)", async () => {
      // A negative index wraps to a huge unsigned value > any length → OOB arm.
      expect(
        await run(`export function test(): number { const a = [10, 20, 30]; let i = -1; return a[i]; }`),
      ).toBeNaN();
    });

    it("OOB read used in arithmetic is NaN (undefined coerces to NaN)", async () => {
      expect(
        await run(`export function test(): number { const a = [10, 20, 30]; let i = 50; return a[i] + 1; }`),
      ).toBeNaN();
    });

    it("in-bounds dynamic read still returns the element", async () => {
      expect(await run(`export function test(): number { const a = [10, 20, 30]; let i = 1; return a[i]; }`)).toBe(20);
    });

    it("end-to-end OOB → undefined when observed in a value context (via SAFE lowering)", async () => {
      // `a[i] === undefined` is a value-context read (not numeric) → the SAFE
      // lowering surfaces JS `undefined`. (This arm reuses #2760's legacy F1 via
      // the f64→externref box demote, which is the SAFE lowering for the
      // value context; the observable result is `undefined`.)
      expect(
        await run(`export function test(): boolean { const a = [1, 4, 5]; let i = 9; return a[i] === undefined; }`),
      ).toBe(1);
    });

    it("externref (any[]) OOB read does not trap", async () => {
      // R1 deferred externref OOB→undefined (it trips the map-on-array-like
      // canary); the IR SAFE read matches legacy here (a nullish OOB value), the
      // point being it must NOT trap.
      const r = await run(`export function test(): any { const x: any[] = [{}, {}, {}]; let i = 99; return x[i]; }`);
      expect(r == null).toBe(true); // null or undefined — nullish, no trap
    });
  });

  describe("FAST path — counted-loop reads keep the unchecked vec.get", () => {
    it("counted-loop sum is correct and keeps the unboxed fast path (no bounds-check if)", async () => {
      const src = `export function sum(): number { const a = [1, 2, 3, 4, 5]; let s = 0; for (let i = 0; i < a.length; i++) { s += a[i]; } return s; }`;
      expect(await run(src, "sum")).toBe(15);
      const info = await compileInfo(src, "sum");
      expect(info.demotions).toBe(0); // stayed on the IR path
      expect(info.hasStructuredIf).toBe(false); // proven → NO bounds-check branch
      expect(info.outcome).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
        preparedComponentId: expect.stringMatching(/^prepared-component:/),
      });
    });

    it("an UNPROVEN read emits a SAFE bounds-check branch (structural counterpart)", async () => {
      const src = `export function rd(): number { const a = [1, 2, 3]; let i = 99; return a[i]; }`;
      const info = await compileInfo(src, "rd");
      expect(info.demotions).toBe(0);
      expect(info.hasStructuredIf).toBe(true); // not proven → SAFE bounds-check
      expect(info.body).toContain("i32.lt_u");
      expect(info.body).toContain("array.get");
      expect(info.body).not.toContain("i32.trunc_sat_f64_s");
      expect(info.body).not.toContain("f64.convert_i32_s");
      expect(info.outcome).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
        preparedComponentId: expect.stringMatching(/^prepared-component:/),
      });
    });

    it("a counted loop that reads arr[i+1] is NOT proven and stays safe at the boundary", async () => {
      // `i+1` is not a simple induction var → not proven → SAFE read. The last
      // iteration reads OOB → NaN (not a trap), so the sum is NaN.
      expect(
        await run(
          `export function s(): number { const a = [1, 2, 3]; let t = 0; for (let i = 0; i < a.length; i++) { t += a[i + 1]; } return t; }`,
          "s",
        ),
      ).toBeNaN();
    });
  });

  describe("numeric-context Math.* guard (R1's funcIdx-shift regression must not recur)", () => {
    // R1's lesson: boxing an array read in a numeric context shifted a host
    // funcIdx already captured by Math.pow → miscompile. The IR SAFE read never
    // boxes (the f64 OOB default is an `f64.const NaN`, no late import), so
    // Math.* over array reads must stay correct.
    it("Math.pow over an in-bounds read is correct", async () => {
      expect(
        await run(`export function test(): number { const a = [2, 3, 4]; let i = 1; return Math.pow(a[i], 2); }`),
      ).toBe(9);
    });

    it("Math.max over two reads (one OOB → NaN) is correct", async () => {
      // Math.max(a[0]=5, a[99]=NaN) === NaN in JS.
      expect(
        await run(`export function test(): number { const a = [5, 6]; let i = 99; return Math.max(a[0], a[i]); }`),
      ).toBeNaN();
    });

    it("Math.hypot/pow chain over a counted-loop (proven) read is correct", async () => {
      // Proven counted-loop reads keep the fast path even under Math.* consumers.
      expect(
        await run(
          `export function test(): number { const a = [3, 4]; let acc = 0; for (let i = 0; i < a.length; i++) { acc += Math.pow(a[i], 2); } return acc; }`,
        ),
      ).toBe(25);
    });
  });

  describe("R1 F1 i32-element corruption guard (#2766 — F1 narrowed to f64/number[])", () => {
    // The folded-in #2760 F1 OOB→undefined widening boxed the in-bounds element
    // via coerceType(i32→externref) = __box_number. `i32` is overloaded: it backs
    // boolean[] AND symbol-handle arrays. Boxing a non-number i32 as a number
    // corrupted it. These guard the two real test262 regressions the merge_group
    // caught (Object/values/symbols-omitted.js + 21 Array/prototype/map boolean
    // tests) by exercising the same element-read paths directly.
    it("symbol element identity survives Object.values()[i] (was boxed as __box_number)", async () => {
      expect(
        await run(
          `export function test(): boolean { const s = Symbol("v"); const o = { k: s }; const vs = Object.values(o); return vs[0] === s; }`,
        ),
      ).toBe(1);
    });

    it("boolean map result reads are true/false, not numbers (host)", async () => {
      expect(
        await run(
          `export function test(): boolean { const r = [1, -1, 2].map((x: number) => x > 0); return r[0] === true && r[1] === false && r[2] === true; }`,
        ),
      ).toBe(1);
    });

    it("boolean map result reads are true/false in STANDALONE (the regressed lane)", async () => {
      const r = await compile(
        `export function test(): boolean { const r = [1, -1, 2].map((x: number) => x > 0); return r[0] === true && r[1] === false && r[2] === true; }`,
        { target: "standalone" },
      );
      expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
      const { instance } = await WebAssembly.instantiate(r.binary, {});
      expect((instance.exports.test as () => number)()).toBe(1);
    });
  });
});
