// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2620 (split from #2606 Bug B) — `class X extends Set/Map/WeakMap/WeakSet`
// under `--target standalone`/`wasi` (nativeStrings) had TWO substrate defects:
//
//   A. Host-import leak: even a bare `class MySet extends Set {}` lowered
//      construction through the host-constructible path (these names are in
//      BUILTIN_PARENTS_HOST_CONSTRUCTIBLE), leaking an unsatisfiable
//      `env::__new_Set` import — the module failed to instantiate.
//   B. Late-import index-shift (#2043 class): the synthetic `<Class>_<method>`
//      accessor (`MySet_size`/`MySet_has`) desynced across the
//      addUnionImports/flushLateImportShifts reorder, baking a `-1` global /
//      a stale call funcIdx → invalid Wasm.
//
// #2620's response was a blanket compile-time refusal of the whole population.
//
// #3972 FIXES DEFECT A AT THE ROOT and narrows the refusal to what is still
// genuinely broken. `emitStandaloneCollectionSuperCtor` (map-runtime.ts) gives
// `super()` a DEFINED `$Map` constructor — the same `__map_new(kind)` carrier
// base `new Set()` uses, stamped with the correct immutable `MAP_LAYOUT.M_KIND`
// brand. With no late IMPORT registered there is also no reorder, so defect B
// cannot arise from construction either.
//
// THE NARROWING IS MEASURED, NOT GUESSED. Two checks moved the boundary from
// where it was first drawn:
//
//   1. The feared "lifting this leaks `env::Set_add`" does NOT happen. A bare
//      subclass followed by `s.add(1)` compiles with ZERO imports and runs: the
//      typed method path does gate on the receiver's static symbol name (so the
//      `"Set"`-named arm misses for a subclass-typed receiver), but the
//      fall-through reaches the value-representation dispatch, which brand-tests
//      `$Map` and reads `M_KIND` — and the carrier IS a correctly branded `$Map`,
//      precisely so that path can succeed. Declared METHODS and an explicit
//      `constructor() { super(); }` also compile and return correct values.
//   2. What IS still broken is a declared PROPERTY or ACCESSOR: those trap at
//      runtime (`illegal cast`). That is NOT collection-specific — it is a
//      pre-existing defect of the whole externref-backed subclass family, which
//      `main` already ships unguarded for the rungs that landed earlier
//      (`extends Array { tag = 3 }` and `extends Uint8Array { tag = 3 }` trap
//      identically today; `extends Object { tag = 3 }` silently yields NaN).
//
// So the refusal now covers ONLY property/accessor declarations. That is
// deliberately asymmetric with the Array/TypedArray rungs, in the conservative
// direction: a clean compile error beats the trap those rungs produce. The
// terminal fix is to repair field storage for externref-backed subclasses across
// the family, at which point this guard should be deleted for all rungs at once.
//
// This file pins: (1) the bare/identity shape now compiles host-free, instantiates
// against an EMPTY import object, and answers `instanceof` correctly; (2) declared
// methods and explicit constructors likewise; (3) a declared field/accessor is
// still a clean CE with no leak and no invalid binary; (4) gc/host mode is
// UNAFFECTED.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const COLLECTIONS = ["Set", "Map", "WeakMap", "WeakSet"] as const;

/** Type arguments that make each collection well-typed in the test sources. */
const TYPE_ARGS: Record<(typeof COLLECTIONS)[number], string> = {
  Set: "<number>",
  Map: "<string, number>",
  WeakMap: "<object, number>",
  WeakSet: "<object>",
};

/**
 * Standalone: the subclass must compile with NO host import, instantiate against
 * an EMPTY import object, and answer `instanceof` correctly. Asserting all three
 * is the point — "compiles" alone would not have caught defect A (which failed at
 * instantiate) or defect B (invalid Wasm).
 */
async function expectNativeCollectionSubclass(parent: string, body: string, expected: number): Promise<void> {
  const targs = TYPE_ARGS[parent as (typeof COLLECTIONS)[number]];
  const src =
    `class Sub extends ${parent}${targs} { ${body} }\n` +
    `export function test(): number { const s = new Sub(); return (s instanceof Sub) && (s instanceof ${parent}) ? ${expected} : -1; }`;
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const labels = r.imports.map((im: { module?: string; name?: string }) => `${im.module}::${im.name}`);
  expect(
    labels.filter((l) => l.startsWith("env::")),
    `extends ${parent} leaked host imports: ${labels.join(", ")}`,
  ).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const ex = instance.exports as Record<string, () => number>;
  expect(ex.test!(), `extends ${parent} instanceof answered incorrectly`).toBe(expected);
}

/** A declared field/accessor must still be a CLEAN refusal — no leak, no binary. */
async function expectFieldRefusal(parent: string, body: string): Promise<void> {
  const targs = TYPE_ARGS[parent as (typeof COLLECTIONS)[number]];
  const src = `class Sub extends ${parent}${targs} { ${body} }
    export function test(): number { return 0; }`;
  const r = await compile(src, { target: "standalone" });
  expect(r.success, `expected a clean refusal, but compile succeeded for extends ${parent}`).toBe(false);
  const errs = r.errors.filter((e) => e.severity === "error").map((e) => e.message);
  expect(
    errs.some((m) => m.includes("#2620") || m.includes("#3972")),
    `expected a #2620/#3972 refusal for extends ${parent}, got: ${errs.join(" | ")}`,
  ).toBe(true);
  // No env host-import leak survived into the (empty) binary.
  const env = (r.imports ?? []).filter((i: { module?: string }) => i.module === "env");
  expect(env.length, `extends ${parent} leaked env imports: ${env.map((i: any) => i.name).join(",")}`).toBe(0);
}

describe("#2620/#3972 standalone subclass of a native collection", () => {
  for (const parent of COLLECTIONS) {
    it(`standalone: bare 'class Sub extends ${parent} {}' compiles host-free and instantiates (was: env.__new_${parent} leak)`, async () => {
      await expectNativeCollectionSubclass(parent, "", 1);
    });

    it(`standalone: 'class Sub extends ${parent}' with a declared METHOD compiles host-free`, async () => {
      await expectNativeCollectionSubclass(parent, "extra(): number { return 1; }", 1);
    });

    it(`standalone: 'class Sub extends ${parent}' with an explicit constructor compiles host-free`, async () => {
      await expectNativeCollectionSubclass(parent, "constructor() { super(); }", 1);
    });

    it(`standalone: 'class Sub extends ${parent}' with a declared FIELD is still a clean refusal`, async () => {
      await expectFieldRefusal(parent, "tag: number = 3;");
    });

    it(`standalone: 'class Sub extends ${parent}' with a declared ACCESSOR is still a clean refusal`, async () => {
      await expectFieldRefusal(parent, "get tag(): number { return 3; }");
    });
  }

  it("standalone: inherited Set.add on a bare subclass stays host-free (the narrowing's load-bearing premise)", async () => {
    // This is the measurement that falsified "lifting the refusal leaks
    // env::Set_add". If this ever starts leaking, the narrowing's justification
    // is gone and the boundary must be revisited — not the assertion relaxed.
    const r = await compile(
      `class Sub extends Set<number> {}
       export function test(): number { const s = new Sub(); s.add(1); return 0; }`,
      { target: "standalone" },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const labels = r.imports.map((im: { module?: string; name?: string }) => `${im.module}::${im.name}`);
    expect(
      labels.filter((l) => l.startsWith("env::")),
      `leaked: ${labels.join(", ")}`,
    ).toEqual([]);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const ex = instance.exports as Record<string, () => number>;
    expect(ex.test!()).toBe(0);
  });

  // gc/host mode must be UNAFFECTED — the externClass host path compiles the
  // subclass there (every #3972 arm is standalone/wasi-gated).
  it("gc/host mode still compiles a Set subclass (the native arms are standalone-only)", async () => {
    const r = await compile(
      `class MySet extends Set<number> {}
       export function test(): number { const s = new MySet([1, 2]); return 0; }`,
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    // gc/host path may legitimately use the __new_Set host import — that's fine.
    await WebAssembly.compile(r.binary);
  });
});
