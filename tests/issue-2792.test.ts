// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2792 — Hybrid F1 `symbol[]` OOB → `undefined` (HOST mode). Completes the host
// half of #2785's deferred `symbol[]` arm: #2785 made `coerceType(i32 →
// externref)` brand-aware and re-enabled `boolean[]` OOB→undefined, deferring
// `symbol[]`. This issue widens F1 so a genuine `symbol[]` reads JS `undefined`
// out of bounds and a value-correct boxed `Symbol` in bounds — in HOST mode,
// via the identity-stable host `__box_symbol` cache.
//
// STANDALONE `symbol[]` STAYS DEFERRED (unchanged from #2785). A native
// standalone `__box_symbol` needs a new `__box_symbol_struct` carrier;
// registering one unconditionally in `addUnionImportsAsNativeFuncs` shifted
// standalone type/func indices and broke ~311 unrelated standalone tests with
// `illegal cast` traps in `__obj_find`/`__extern_set` (the type-index-shift /
// DCE-remap hazard). So `f1ElementBoxType` returns the symbol brand only when
// `!noJsHost(ctx)`; standalone `symbol[]` falls through to the shared bounded
// read (i32 handle), exactly as before. The standalone native carrier is carved
// to a follow-up that can add it without the broad index shift.
//
// Discipline (#2785's "bound blast radius"): symbols are NOT broadly branded in
// type-mapper — that mismatched other boxing sites (object-literal fields stay on
// `__box_number`) and regressed the host `symbols-omitted` canary. F1 keys on the
// receiver TS type (`f1ElementBoxType` reconstructs the brand), so its box choice
// is self-consistent. The `symbols-omitted` canary's `Object.values(any)` result
// is an externref array, so F1 defers there regardless.
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
// instantiation; the binary must be valid Wasm).
async function runStandalone(source: string, fn = "test"): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>)[fn]() as number;
}

const ARR = `const s0 = Symbol("a"); const s1 = Symbol("b"); const a: symbol[] = [s0, s1];`;

describe("#2792 — host symbol[] OOB → JS `undefined` (completes #2785's deferred arm)", () => {
  describe("symbol[] OOB → undefined (host)", () => {
    it("a[OOB] === undefined (literal index past end)", async () => {
      expect(await run(`export function test(): boolean { ${ARR} return a[4] === undefined; }`)).toBe(1);
    });

    it("dynamic OOB index reads undefined", async () => {
      expect(await run(`export function test(): boolean { ${ARR} let i = 9; return a[i] === undefined; }`)).toBe(1);
    });

    it("negative index reads undefined", async () => {
      expect(await run(`export function test(): boolean { ${ARR} return a[-1] === undefined; }`)).toBe(1);
    });

    it("a[OOB] surfaces to JS as undefined (NOT a Number from __box_number)", async () => {
      // The exact #2785 first-park failure mode: a symbol handle boxed via
      // __box_number surfaced a Number. The OOB read is `undefined` regardless,
      // but this asserts the value identity at the JS boundary.
      expect(await run(`export function test(): any { ${ARR} let i = 7; return a[i]; }`)).toBe(undefined);
    });
  });

  describe("symbol[] in-bounds box preserves the SYMBOL identity (host)", () => {
    it("in-bounds read is a real Symbol with the right description", async () => {
      // Boxed via __box_symbol → the host symbol cache returns the registered
      // Symbol("hi"), so `.description` round-trips (a number box has no
      // `.description`). Strong proof the value is a Symbol, not a Number.
      expect(
        await run(
          `export function test(): any { const s = Symbol("hi"); const a: symbol[] = [s]; let i = 0; const r: any = a[i]; return r.description; }`,
        ),
      ).toBe("hi");
    });

    it("per-element identity — a[i] === a[0] (same element → same cached Symbol)", async () => {
      expect(await run(`export function test(): boolean { ${ARR} let i = 0; return a[i] === a[0]; }`)).toBe(1);
    });

    it("distinct elements are NOT === — a[0] !== a[1]", async () => {
      expect(await run(`export function test(): boolean { ${ARR} let i = 0; return a[i] === a[1]; }`)).toBe(0);
    });
  });

  describe("standalone: symbol[] DEFERRED (unchanged from #2785 — must not regress)", () => {
    it("standalone symbol[] compiles to valid Wasm and reads handles in bounds", async () => {
      // Standalone defers symbol[] (no native __box_symbol carrier). The element
      // read falls through to the shared bounded read (i32 handle); === on the
      // handles is still correct (same element equal, distinct elements not).
      expect(await runStandalone(`export function test(): boolean { ${ARR} let i = 0; return a[i] === a[0]; }`)).toBe(
        1,
      );
      expect(await runStandalone(`export function test(): boolean { ${ARR} let i = 0; return a[i] === a[1]; }`)).toBe(
        0,
      );
    });
  });

  describe("canaries — must stay green host + standalone (the #2785 parks + symbol-as-any guard)", () => {
    it("symbols-omitted: Object.values({key: s})[0] === s (any-array → F1 defers) — host", async () => {
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

    it("boolean map: result reads are true/false in STANDALONE", async () => {
      expect(
        await runStandalone(
          `export function test(): boolean { const r = [1, -1, 2].map((x: number) => x > 0); return r[0] === true && r[1] === false && r[2] === true; }`,
        ),
      ).toBe(1);
    });

    it("number[] OOB === undefined regression guard — host", async () => {
      expect(
        await run(`export function test(): boolean { const a: number[] = [1, 4, 5]; return a[4] === undefined; }`),
      ).toBe(1);
    });

    it("number[] OOB === undefined regression guard — standalone", async () => {
      expect(
        await runStandalone(
          `export function test(): boolean { const a: number[] = [1, 4, 5]; let i = 9; return a[i] === undefined; }`,
        ),
      ).toBe(1);
    });
  });
});
