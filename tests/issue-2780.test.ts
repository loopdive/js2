// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2780 — Hybrid IR step 2: ArrayLiteral widening-escape check.
//
// `#1804` lowers a fixed-length, same-typed array literal to a packed
// `vec.new_fixed` (a homogeneous NARROW vec — `vec<f64>` for `number[]`,
// `vec<i32>` for `boolean[]`). Per the Hybrid Invariant that specialization is
// only sound when the literal provably is NOT widened to an `any` /
// heterogeneous element type. This step adds a LOCAL widening-escape proof to
// `lowerArrayLiteral` (mirroring #2766's prove-then-specialize shape):
//   - FAST: the literal's contextual sink is concrete & homogeneous (or absent)
//     → keep `vec.new_fixed`.
//   - SAFE: the sink demands a WIDER / heterogeneous element type
//     (`any[]` / `unknown[]` / a union) → demote to the legacy lowering, which
//     boxes each element to the dynamic externref representation. Value-correct
//     either way.
//
// The proof reads the TS TYPE (`TypeFlags`), never the Wasm kind: `number[]`,
// `boolean[]` and `symbol[]` all collapse to the same element ValType, so keying
// on the kind would misclassify. The intrinsic `boolean` type is internally the
// union `true | false` (so `isUnion()` is true for it) — it is excluded via the
// `Boolean` flag so `boolean[]` stays on the fast path.

import { describe, expect, it } from "vitest";
import { compile, type IrObservedOutcome } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { analyzeSource } from "../src/checker/index.js";
import { planIrCompilation } from "../src/ir/select.js";

const WIDENING = "widening/heterogeneous sink";

/** The selector claims `fn` for IR compilation (proves it reaches the IR path). */
function isClaimed(source: string, fn: string): boolean {
  const ast = analyzeSource(source, "input.ts");
  const sel = planIrCompilation(ast.sourceFile, { experimentalIR: true });
  return sel.funcs.has(fn);
}

/** Compile via the IR path; return the run value + the widening-demotion list. */
async function compileRun(
  source: string,
  fn: string,
): Promise<{
  value: unknown;
  wideningDemotions: number;
  success: boolean;
  wat: string;
  outcome?: IrObservedOutcome;
}> {
  const r = await compile(source, { experimentalIR: true, trackIrOutcomes: true, emitWat: true });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors[0]?.message ?? "unknown"}`);
  }
  const wideningDemotions = (r.irPostClaimErrors ?? []).filter((e) => e.message.includes(WIDENING)).length;
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports as unknown as WebAssembly.Imports);
  (imports as { setExports?: (e: Record<string, Function>) => void }).setExports?.(
    instance.exports as Record<string, Function>,
  );
  const f = (instance.exports as Record<string, unknown>)[fn];
  if (typeof f !== "function") throw new Error(`export ${fn} missing`);
  return {
    value: (f as () => unknown)(),
    wideningDemotions,
    success: r.success,
    wat: r.wat,
    outcome: r.irOutcomes?.find((candidate) => candidate.displayName === fn),
  };
}

describe("#2780 — IR ArrayLiteral widening-escape check", () => {
  // ── FAST: proof holds → packed vec.new_fixed kept, NO widening demotion ──────
  describe("FAST path — no widening, fast vec.new_fixed kept", () => {
    it("no-annotation number[] (no contextual sink) sums via the IR vec", async () => {
      const src = `export function sum(): number { const a = [1,2,3]; let t = 0; for (const x of a) { t += x; } return t; }`;
      expect(isClaimed(src, "sum"), "function IR-claimed").toBe(true);
      const { value, wideningDemotions, wat, outcome } = await compileRun(src, "sum");
      expect(value).toBe(6);
      expect(wideningDemotions, "no widening demotion on the FAST path").toBe(0);
      expect(wat).toContain("array.new_fixed");
      expect(outcome).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
        preparedComponentId: expect.stringMatching(/^prepared-component:/),
      });
    });

    it("no-annotation number[] indexed + length", async () => {
      const src = `export function test(): number { const a = [10,20,30,40,50]; return a[2] + a.length; }`;
      expect(isClaimed(src, "test")).toBe(true);
      const { value, wideningDemotions } = await compileRun(src, "test");
      expect(value).toBe(35);
      expect(wideningDemotions).toBe(0);
    });

    it("literal passed where a concrete number[] is expected stays FAST (no widening)", async () => {
      // A concrete, homogeneous contextual element type (`number`) at the call
      // arg — the proof holds, so the widening gate does NOT fire.
      const src = `function g(x: number[]): number { return x[0] + x.length; }
        export function test(): number { return g([1,2,3]); }`;
      expect(isClaimed(src, "test")).toBe(true);
      const { value, wideningDemotions } = await compileRun(src, "test");
      expect(value).toBe(4);
      expect(wideningDemotions, "number[] sink is not a widening").toBe(0);
    });

    it("boolean[] is NOT treated as a union widening (the true|false flag gotcha)", async () => {
      // `boolean` is internally `true | false`, so `isUnion()` is true — the gate
      // must exclude it (via the Boolean flag) and keep boolean[] on the fast path.
      const src = `function g(x: boolean[]): number { return x.length; }
        export function test(): number { return g([true,false,true]); }`;
      expect(isClaimed(src, "test")).toBe(true);
      const { value, wideningDemotions } = await compileRun(src, "test");
      expect(value).toBe(3);
      expect(wideningDemotions, "boolean[] must stay FAST").toBe(0);
    });
  });

  // ── SAFE: proof fails → demote to the boxed legacy lowering, still correct ───
  describe("SAFE path — widening sink demotes to legacy, value-correct", () => {
    it("literal passed where an any[] is expected demotes via the widening gate", async () => {
      const src = `function g(x: any[]): number { return x.length; }
        export function test(): number { return g([1,2,3]); }`;
      // The function IS IR-claimed (so the literal reaches lowerArrayLiteral),
      // and the widening gate is the demotion cause — not the incidental
      // "mixed-type" throw.
      expect(isClaimed(src, "test"), "function IR-claimed (literal reaches the lowerer)").toBe(true);
      const { value, wideningDemotions } = await compileRun(src, "test");
      expect(wideningDemotions, "demoted via the explicit widening-escape gate").toBeGreaterThan(0);
      expect(value, "still JS-correct via the SAFE (boxed) legacy lowering").toBe(3);
    });

    it("unknown[] / union[] sinks remain JS-correct (handled SAFE)", async () => {
      // These lower via a path that does not reach lowerArrayLiteral, but the HI
      // guarantee is the same: the result is JS-correct regardless of mechanism.
      const unk = `function g(x: unknown[]): number { return x.length; }
        export function test(): number { return g([1,2,3]); }`;
      const uni = `function g(x: (number|string)[]): number { return x.length; }
        export function test(): number { return g([1,2,3]); }`;
      expect((await compileRun(unk, "test")).value).toBe(3);
      expect((await compileRun(uni, "test")).value).toBe(3);
    });
  });
});
