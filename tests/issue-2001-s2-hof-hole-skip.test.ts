// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2001 S2 — HOF hole visit-skip on the dense WasmGC vec.
//
// The ES `HasProperty(O, ‹k›) is false ⇒ skip` array methods must NOT run their
// per-iteration work for an absent index (a `$Hole` slot in an `any[]`/untyped
// externref vec, per S1). This slice adds the skip gate to the dense-vec loop
// drivers of: forEach, filter, some, every, reduce, reduceRight, indexOf,
// lastIndexOf. reduce/reduceRight also seek the first/last PRESENT index for
// the no-initial-value seed.
//
// NOT skip methods (they use `[[Get]]`, ES6): find, findIndex, includes — they
// VISIT holes as `undefined` (the S1 read map), unchanged here.
//
// DEFERRED: `map`'s result-hole (a numeric-callback result vec is f64 and can't
// hold the sentinel, and TS types the result `number[]` so downstream consumers
// mis-read a forced-externref result — a separate slice). map still VISITS.
//
// Scope: `any[]` / untyped (externref element) only. Typed `number[]` (f64
// element) keeps materializing `0` at the hole and its HOFs keep visiting —
// accepted divergence (a hole is unrepresentable in the source type).

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string, fn = "run"): Promise<unknown> {
  const result = await compile(source, { skipSemanticDiagnostics: true });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn]();
}

async function runStandalone(source: string, fn = "run"): Promise<unknown> {
  const result = await compile(source, { skipSemanticDiagnostics: true, target: "standalone" });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn]();
}

describe("#2001 S2 — HOF hole visit-skip (any[] / externref vecs)", () => {
  describe("forEach", () => {
    it("does not visit the hole ([1,,3] → 2 calls)", async () => {
      expect(
        await run(
          `export function run(): number { const a: any[] = [1,,3]; let c=0; a.forEach(()=>{c++;}); return c; }`,
        ),
      ).toBe(2);
    });
    it("index-grow gap is still visited (S3 boundary — gap is filled, not a $Hole)", async () => {
      // b[5]=9 fills [1,5) with the element default (S7 fills undefined, not
      // $Hole) — those become present indices. Documenting the S3 boundary: the
      // grow-gap is NOT a literal hole, so forEach visits it. Count is 6.
      expect(
        await run(
          `export function run(): number { const b: any[] = [1]; b[5]=9; let c=0; b.forEach(()=>{c++;}); return c; }`,
        ),
      ).toBe(6);
    });
  });

  describe("filter", () => {
    it("omits holes ([1,,3].filter(()=>true).length === 2)", async () => {
      expect(
        await run(`export function run(): number { const a: any[] = [1,,3]; return a.filter(()=>true).length; }`),
      ).toBe(2);
    });
    it("a real undefined element is kept", async () => {
      expect(
        await run(
          `export function run(): number { const a: any[] = [1,undefined,3]; return a.filter((x)=>x===undefined).length; }`,
        ),
      ).toBe(1);
    });
  });

  describe("some / every", () => {
    it("some skips the hole ([1,,3].some(x=>x===undefined) === false)", async () => {
      expect(
        await run(`export function run(): boolean { const a: any[] = [1,,3]; return a.some((x)=>x===undefined); }`),
      ).toBe(0);
    });
    it("some still sees a real undefined element", async () => {
      expect(
        await run(
          `export function run(): boolean { const a: any[] = [1,undefined,3]; return a.some((x)=>x===undefined); }`,
        ),
      ).toBe(1);
    });
    it("every: a hole never falsifies ([1,,3].every(x=>x!==undefined) === true)", async () => {
      expect(
        await run(`export function run(): boolean { const a: any[] = [1,,3]; return a.every((x)=>x!==undefined); }`),
      ).toBe(1);
    });
    it("every still falsifies on a real undefined", async () => {
      expect(
        await run(
          `export function run(): boolean { const a: any[] = [1,undefined,3]; return a.every((x)=>x!==undefined); }`,
        ),
      ).toBe(0);
    });
  });

  describe("includes VISITS holes (Get semantics) — not a skip method", () => {
    it("includes(undefined) === true on a hole", async () => {
      expect(
        await run(`export function run(): boolean { const a: any[] = [1,,3]; return a.includes(undefined); }`),
      ).toBe(1);
    });
  });

  // indexOf / lastIndexOf / reduce / reduceRight hole-SKIP is DEFERRED (see the
  // S2 boundary note in the issue): their ONLY test262 sparse-hole coverage
  // combines a hole with a prototype-INHERITED index, which the flat WasmGC vec
  // cannot model — a spec-correct skip regresses those coincidental passes for
  // no offsetting win. They keep the S1 `$Hole → undefined` map (net-0). These
  // cases pin that DEFERRED behavior so a future change is deliberate.
  describe("indexOf / lastIndexOf / reduce / reduceRight — hole-skip DEFERRED (S1 behavior)", () => {
    it("indexOf reads a hole as undefined (deferred — matches at the hole)", async () => {
      expect(await run(`export function run(): number { const a: any[] = [1,,3]; return a.indexOf(undefined); }`)).toBe(
        1,
      );
    });
    it("indexOf of a present value is unaffected around a hole", async () => {
      expect(await run(`export function run(): number { const a: any[] = [1,,3]; return a.indexOf(3); }`)).toBe(2);
    });
    it("lastIndexOf reads a hole as undefined (deferred)", async () => {
      expect(
        await run(`export function run(): number { const a: any[] = [1,,3]; return a.lastIndexOf(undefined); }`),
      ).toBe(1);
    });
    it("reduce with an initial value folds the hole as undefined (deferred → NaN)", async () => {
      // 0 + 1 + undefined + 3: `undefined` numeric-coerces to NaN.
      expect(
        await run(`export function run(): number { const a: any[] = [1,,3]; return a.reduce((x,y)=>x+y, 0); }`),
      ).toBeNaN();
    });
  });

  describe("visit methods (find/findIndex) still visit holes — NOT skipped", () => {
    it("find visits the hole as undefined", async () => {
      expect(
        await run(`export function run(): string { const a: any[] = [,5]; return typeof a.find((x)=>x===undefined); }`),
      ).toBe("undefined");
    });
    it("findIndex visits the hole (returns 0)", async () => {
      expect(
        await run(`export function run(): number { const a: any[] = [,5]; return a.findIndex((x)=>x===undefined); }`),
      ).toBe(0);
    });
  });

  describe("typed number[] guard — accepted divergence, byte path unchanged", () => {
    it("number[] forEach still visits the (materialized) hole ([1,,3] → 3 calls)", async () => {
      expect(
        await run(
          `export function run(): number { const a: number[] = [1,,3]; let c=0; a.forEach(()=>{c++;}); return c; }`,
        ),
      ).toBe(3);
    });
    it("number[] indexOf of a present value is unaffected (byte-identical typed path)", async () => {
      // The typed f64 hole is the sNaN default sentinel (not 0), and the gate is
      // externref-only, so the f64 indexOf is byte-identical to main: a present
      // value is found, and `indexOf(0)` does not match the sentinel slot.
      expect(await run(`export function run(): number { const a: number[] = [1,,3]; return a.indexOf(3); }`)).toBe(2);
      expect(await run(`export function run(): number { const a: number[] = [1,,3]; return a.indexOf(0); }`)).toBe(-1);
    });
  });

  describe("standalone parity (no host import — $Hole is pure WasmGC)", () => {
    it("forEach skip works standalone", async () => {
      expect(
        await runStandalone(
          `export function run(): number { const a: any[] = [1,,3]; let c=0; a.forEach(()=>{c++;}); return c; }`,
        ),
      ).toBe(2);
    });
    it("reduce skip + seed seek works standalone", async () => {
      expect(
        await runStandalone(`export function run(): number { const a: any[] = [5,,,2]; return a.reduce((x,y)=>x+y); }`),
      ).toBe(7);
    });
  });

  // (PR #2832 merge-group park) §23.1.3.* keys the visit-skip on
  // `HasProperty(O, k)` — TRUE for a hole whose index is inherited from
  // `Array.prototype` (test262 `{every,filter,some}/*-c-i-22.js`:
  // `Object.defineProperty(Array.prototype, "0", { set(){}, configurable: true })`
  // then `[, ].some(cb)` MUST visit index 0 with `undefined`). The flat vec
  // cannot check the prototype per element, so a module that writes an
  // `Array.prototype` index anywhere (`arrayProtoIndexDirty` pre-scan) disables
  // the module-wide skip and falls back to the S1 visit-with-`undefined`
  // behavior — matching the observable result of the inherited
  // accessor-without-getter shape ([[Get]] yields `undefined`).
  describe("Array.prototype index write disables the module's visit-skip", () => {
    // These run STANDALONE deliberately: in host mode the compiled module
    // EXECUTES its `defineProperty(Array.prototype, "0", …)` against the host
    // realm's REAL Array.prototype, and the inherited index-0 accessor poisons
    // every later array index-write in this vitest worker (the TS compiler
    // itself crashes on its next parse — statements arrays silently drop
    // element 0 through the no-op setter; verified: an `afterEach` delete is
    // not enough, async runtime state corrupts while poisoned). Standalone
    // instances model Array.prototype in-module — fully isolated per test —
    // and exercise the same `arrayProtoIndexDirty` compile-time gate.
    it("some visits the hole after defineProperty(Array.prototype, '0', …)", async () => {
      expect(
        await runStandalone(`
          function cb(val: any, idx: any): any { if (idx === 0) { return typeof val === "undefined"; } return false; }
          Object.defineProperty(Array.prototype, "0", { set: function() {}, configurable: true });
          export function run(): number { const a: any[] = [, ]; return a.some(cb) ? 1 : 0; }
        `),
      ).toBe(1);
    });
    it("every visits the hole (callback observed) after the proto write", async () => {
      expect(
        await runStandalone(`
          let accessed = false;
          function cb(val: any, idx: any): any { if (idx === 0) { accessed = true; return typeof val === "undefined"; } return true; }
          Object.defineProperty(Array.prototype, "0", { set: function() {}, configurable: true });
          export function run(): number {
            const a: any[] = [, ];
            if (!a.every(cb)) return 2;
            return accessed ? 1 : 3;
          }
        `),
      ).toBe(1);
    });
    it("filter keeps the visited hole after the proto write", async () => {
      expect(
        await runStandalone(`
          function cb(val: any, idx: any): any { if (idx === 0) { return typeof val === "undefined"; } return false; }
          Object.defineProperty(Array.prototype, "0", { set: function() {}, configurable: true });
          export function run(): number { const a: any[] = [, ]; return a.filter(cb).length; }
        `),
      ).toBe(1);
    });
    it("element-assignment form (Array.prototype[0] = v) also disables the skip", async () => {
      expect(
        await runStandalone(`
          Array.prototype[0] = 6.99;
          export function run(): number {
            const a: any[] = [, ];
            let calls = 0;
            a.forEach(function(x: any) { calls = calls + 1; });
            return calls;
          }
        `),
      ).toBe(1);
    });
    it("a mere READ of Array.prototype does NOT disable the skip", async () => {
      // Host mode is safe here — reading Array.prototype mutates nothing.
      expect(
        await run(`
          const f: any = Array.prototype.indexOf;
          export function run(): number {
            const a: any[] = [1, , 3];
            let calls = 0;
            a.forEach(function(x: any) { calls = calls + 1; });
            return calls;
          }
        `),
      ).toBe(2);
    });
  });
});
