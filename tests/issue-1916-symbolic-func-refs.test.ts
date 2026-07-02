// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";

/**
 * #1916 — symbolic function references / #2710 late-bound module indices.
 *
 * S1 (this slice) wires every func/global reference serialization in
 * `src/emit/binary.ts` through the `resolveLayout()` seam
 * (`src/emit/resolve-layout.ts`). The layout is the identity map in this
 * phase, so behaviour must be EXACTLY unchanged — proven wholesale by
 * `scripts/prove-emit-identity.mjs` (992 real binaries × {gc,standalone,wasi}
 * byte-identical) and held here by two kinds of permanent tests:
 *
 * 1. late-import-after-bodies programs (the #329/#1899/#1677 repro shapes):
 *    imports added AFTER function bodies were compiled historically shifted
 *    every defined-function index and corrupted baked call targets. These
 *    must compile to VALID Wasm and run correctly through every migration
 *    slice — they are the acceptance evidence that handle resolution agrees
 *    with the final index space.
 *
 * 2. a synthetic hand-built module exercising every seam S1 touched (call,
 *    ref.func + declarative elem, global.get/set, func + global exports,
 *    start section, active element segments) — validating that the resolver
 *    dereference emits exactly the indices the module laid out.
 */

// The #1899 repro: `let g: any` forces an undefined-init path; the closure
// assignment bakes a call target; native-string helpers + host-import gate
// churn imports afterwards under standalone/wasi.
const assignAfterBodies = `let g: any; g = function () { return 42; };
export function test(): number { return g(); }`;

// String-helper-heavy variant — exercises the native-string finalize regime
// (reconcileNativeStrFinalizeShift) where sibling-helper calls bake mid-churn.
const stringHelperChurn = `const s: string = "ab" + "cd";
export function test(): number { return s.slice(1).length + "x".repeat(2).length; }`;

// Union-typed return forces addUnionImports — the late-import path that
// historically shifted indices after ALL bodies existed (#1461/#2918 class).
const unionLateImport = `function pick(n: number): number | string {
  return n > 0 ? n : "neg";
}
export function test(): number {
  const v = pick(3);
  return typeof v === "number" ? v : 0;
}`;

async function compileValidate(src: string, target: "standalone" | "wasi" | "gc") {
  const r = await compile(src, { target });
  expect(r.errors ?? []).toEqual([]);
  // WebAssembly.compile throws on stale-funcIdx invalid Wasm — the historical
  // failure mode of this bug class.
  await WebAssembly.compile(r.binary);
  return r;
}

describe("#1916 S1 — late-import-after-bodies programs stay valid through the resolver seam", () => {
  for (const target of ["standalone", "wasi", "gc"] as const) {
    it(`assignment-form closure late-shift shape [${target}]`, async () => {
      await compileValidate(assignAfterBodies, target);
    });

    it(`native-string helper churn shape [${target}]`, async () => {
      await compileValidate(stringHelperChurn, target);
    });

    it(`union late-import shape [${target}]`, async () => {
      await compileValidate(unionLateImport, target);
    });
  }

  it("standalone closure-assign runs to the right value", async () => {
    const r = await compile(assignAfterBodies, { target: "standalone" });
    expect(r.errors ?? []).toEqual([]);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const test = instance.exports.test as () => number;
    expect(test()).toBe(42);
  });
});

describe("#1916 S3a — stable-regime handles (two-regime coexistence)", () => {
  // The acceptance criterion of the whole migration: a producer whose function
  // handles are STABLE must stay correct when late imports land AFTER its
  // functions were emitted and its call immediates were baked. The
  // number-format family (number_toString/toFixed/toPrecision +
  // __num_fmt_finalize sibling calls) is the first stable-regime producer;
  // string concatenation + union returns force late imports around it.
  it("stable-regime producer survives late-import churn (all targets)", async () => {
    const src = `export function test(): number {
      const hex: string = (255).toString(16);      // number-format family (stable handles)
      const fixed: string = (1.5).toFixed(1);
      let g: any; g = function () { return 2; };    // late closure/undefined-init imports
      const s: string = hex + fixed;                // native-string helpers churn
      return s.length + g();                        // "ff1.5".length + 2 = 7
    }`;
    for (const target of ["standalone", "wasi", "gc"] as const) {
      const r = await compile(src, { target });
      expect(r.errors ?? []).toEqual([]);
      await WebAssembly.compile(r.binary);
    }
    const r = await compile(src, { target: "standalone" });
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports.test as () => number)()).toBe(7);
  });

  it("a stable handle resolves through funcOrdinalToPosition at emit", async () => {
    const { STABLE_FUNC_BASE } = await import("../src/emit/resolve-layout.js");
    const mod = createEmptyModule();
    mod.types.push({ kind: "func", params: [], results: [{ kind: "i32" }] });
    // Two defined functions; the SECOND (position 1) is registered under
    // stable ordinal 0. A call to STABLE_FUNC_BASE+0 must encode as index
    // numImports(0) + position(1) = 1.
    mod.functions.push({
      name: "callsStable",
      typeIdx: 0,
      locals: [],
      body: [{ op: "call", funcIdx: STABLE_FUNC_BASE + 0 }],
      exported: true,
    });
    mod.functions.push({
      name: "target",
      typeIdx: 0,
      locals: [],
      body: [{ op: "i32.const", value: 41 }],
      exported: false,
    });
    mod.funcOrdinalToPosition.push(1); // ordinal 0 → position 1
    mod.exports.push({ name: "callsStable", desc: { kind: "func", index: 0 } });

    const bytes = emitBinary(mod);
    expect(WebAssembly.validate(bytes)).toBe(true);
    const { instance } = await WebAssembly.instantiate(bytes, {});
    expect((instance.exports.callsStable as () => number)()).toBe(41);
  });

  it("a minted-but-never-pushed stable handle fails loudly at emit", async () => {
    const { STABLE_FUNC_BASE } = await import("../src/emit/resolve-layout.js");
    const mod = createEmptyModule();
    mod.types.push({ kind: "func", params: [], results: [{ kind: "i32" }] });
    mod.functions.push({
      name: "callsUnpushed",
      typeIdx: 0,
      locals: [],
      body: [{ op: "call", funcIdx: STABLE_FUNC_BASE + 0 }],
      exported: true,
    });
    mod.funcOrdinalToPosition.push(Number.NaN); // minted, never pushed
    mod.exports.push({ name: "callsUnpushed", desc: { kind: "func", index: 0 } });
    expect(() => emitBinary(mod)).toThrow(/no recorded position/);
  });
});

describe("#1916 S1 — synthetic module exercises every resolver seam", () => {
  it("call / ref.func / global.get+set / exports / start / elem resolve to correct indices", async () => {
    const mod = createEmptyModule();

    // Types: () -> i32 (funcs), () -> nothing (start)
    mod.types.push({ kind: "func", params: [], results: [{ kind: "i32" }] }); // 0
    mod.types.push({ kind: "func", params: [], results: [] }); // 1

    // One mutable i32 global, init 5 — read via global.get, written by start.
    mod.globals.push({
      name: "g0",
      type: { kind: "i32" },
      mutable: true,
      init: [{ op: "i32.const", value: 5 }],
    });

    // func 0: inner() -> 7
    mod.functions.push({
      name: "inner",
      typeIdx: 0,
      locals: [],
      body: [{ op: "i32.const", value: 7 }],
      exported: false,
    });
    // func 1: outer() -> inner() + g0   (seams: call, global.get)
    mod.functions.push({
      name: "outer",
      typeIdx: 0,
      locals: [],
      body: [{ op: "call", funcIdx: 0 }, { op: "global.get", index: 0 }, { op: "i32.add" }],
      exported: true,
    });
    // func 2: start() { g0 = 30 }   (seams: global.set, start section)
    mod.functions.push({
      name: "init",
      typeIdx: 1,
      locals: [],
      body: [
        { op: "i32.const", value: 30 },
        { op: "global.set", index: 0 },
      ],
      exported: false,
    });
    mod.startFuncIdx = 2;

    // Declarative elem via declaredFuncRefs + a ref.func in a table-less
    // context is overkill here; instead exercise BOTH elem paths:
    mod.declaredFuncRefs.push(0); // declarative segment (ref.func targets)
    mod.tables.push({ elementType: "funcref", min: 1, max: 1 });
    mod.elements.push({ tableIdx: 0, offset: [{ op: "i32.const", value: 0 }], funcIndices: [1] }); // active segment

    mod.exports.push({ name: "outer", desc: { kind: "func", index: 1 } });
    mod.exports.push({ name: "g0", desc: { kind: "global", index: 0 } });

    const bytes = emitBinary(mod);
    expect(WebAssembly.validate(bytes)).toBe(true);

    const { instance } = await WebAssembly.instantiate(bytes, {});
    const outer = instance.exports.outer as () => number;
    // start ran on instantiation: g0 = 30; outer() = inner() + g0 = 7 + 30.
    expect(outer()).toBe(37);
    const g0 = instance.exports.g0 as WebAssembly.Global;
    expect(g0.value).toBe(30);
  });
});
