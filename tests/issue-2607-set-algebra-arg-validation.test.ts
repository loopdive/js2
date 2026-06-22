import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

// #2607 — Standalone Set set-algebra GetSetRecord argument validation.
//
// The ES2025 set-algebra methods (union/intersection/difference/
// symmetricDifference/isSubsetOf/isSupersetOf/isDisjointFrom) run
// GetSetRecord(obj) on their single argument (spec 24.2.1.2): "If obj is not an
// Object, throw a TypeError" + has/keys must be callable. Standalone silently
// completed (host fall-through / leak) or trap-cast a non-Set argument instead
// of throwing the spec TypeError.
//
// Fix: `tryCompileNativeSetAlgebraCall` (set-algebra.ts) replaces the bare
// `castToMap(arg)` with the shared `emitSetBrandCheck` (#2604) — `ref.test $Map`
// → catchable TypeError on a non-Set, else `ref.cast $Map`. The validation/throw
// cases flip; the genuine set-LIKE-object data path is #2580 M2 (dynamic read)
// and conservatively (correctly) throws here for now.

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone", skipSemanticDiagnostics: true } as never);
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  const io = r.importObject as WebAssembly.Imports & { __setExports?: (e: Record<string, unknown>) => void };
  const { instance } = await WebAssembly.instantiate(r.binary, io);
  io.__setExports?.(instance.exports as Record<string, unknown>);
  return (instance.exports as { test(): unknown }).test();
}

const throwsFor = (method: string, arg: string) =>
  `export function test(): number {
     const s = new Set([1, 2, 3]);
     try { s.${method}(${arg} as any); return 0; }
     catch (e: any) { return e instanceof TypeError ? 1 : 2; }
   }`;

describe("#2607 set-algebra throws TypeError on a non-Set argument", () => {
  const predicates = ["isSubsetOf", "isSupersetOf", "isDisjointFrom"] as const;
  const setOps = ["union", "intersection", "difference", "symmetricDifference"] as const;
  const badArgs = ["1", '""', "true", "[]", "{}"] as const;

  for (const m of predicates) {
    for (const a of badArgs) {
      it(`${m}(${a}) → TypeError`, async () => {
        expect(await runStandalone(throwsFor(m, a))).toBe(1);
      });
    }
  }
  for (const m of setOps) {
    it(`${m}(1) (primitive) → TypeError`, async () => {
      expect(await runStandalone(throwsFor(m, "1"))).toBe(1);
    });
    it(`${m}([]) (array) → TypeError`, async () => {
      expect(await runStandalone(throwsFor(m, "[]"))).toBe(1);
    });
  }
});

describe("#2607 valid Set argument still runs the algebra (no over-throw)", () => {
  it("isSubsetOf(realSet) → boolean", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = new Set([1, 2]); const b = new Set([1, 2, 3]); return a.isSubsetOf(b) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("isDisjointFrom(realSet) → boolean", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = new Set([1]); const b = new Set([2]); return a.isDisjointFrom(b) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("union(realSet) → merged Set size", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = new Set([1]); const b = new Set([2]); return a.union(b).size; }`,
      ),
    ).toBe(2);
  });

  it("intersection(realSet) → common size", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = new Set([1, 2, 3]); const b = new Set([2, 3, 4]); return a.intersection(b).size; }`,
      ),
    ).toBe(2);
  });
});
