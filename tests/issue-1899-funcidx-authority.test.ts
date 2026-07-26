// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, it, expect, vi } from "vitest";
import { compile } from "../src/index.js";
import { eliminateDeadImports } from "../src/codegen/dead-elimination.js";
import type { WasmModule } from "../src/ir/types.js";

/**
 * #1899 — finalize funcIdx-authority contract: the recurring late-shift /
 * index-desync class (#1677 / #1809 / #1839 / #1886 / #329 / #1461 / #2043).
 *
 * Root cause closed here: `eliminateDeadImports` REMOVES dead function imports
 * and remaps every funcIdx INSIDE `mod` through its authoritative `fR` table,
 * but historically left the codegen-context helper side-tables (`funcMap`,
 * `nativeStrHelpers`, `nativeRegexHelpers`, `mapHelpers`,
 * `pendingMethodTrampolines`) stale by the removed-import delta. A post-dead-elim
 * consumer that bakes a NEW `call` from one of those maps (e.g. the
 * `__unbox_number` repair in `fixups.ts`, which runs immediately after dead-elim
 * in `repairStructTypeMismatches` / `fixupExternConvertAny`) would then target
 * the wrong, now-shifted function.
 *
 * Fix: `eliminateDeadImports(mod, ctx)` applies the SAME `fR` remap to the ctx
 * side-tables, in lockstep with the module — exactly as the ADD-direction shift
 * passes already do. This file proves (a) the unit-level remap behaviour
 * directly against a synthetic module, and (b) that the known churning string /
 * closure programs still compile, validate, and run in standalone + wasi.
 */

// --- (a) unit: dead-elim remaps the ctx side-tables in lockstep ---

function fakeCtx(mod: WasmModule) {
  // Minimal CodegenContext stand-in carrying only the fields the #1899 remap
  // touches. Cast through unknown since the real type is large.
  return {
    mod,
    funcMap: new Map<string, number>(),
    nativeStrHelpers: new Map<string, number>(),
    nativeRegexHelpers: new Map<string, number>(),
    mapHelpers: new Map<string, number>(),
    pendingMethodTrampolines: [] as { methodFuncIdx: number; trampolineFuncIdx: number }[],
  };
}

function mkFuncImport(name: string, typeIdx: number) {
  return { module: "env", name, desc: { kind: "func" as const, typeIdx } };
}

describe("#1899 dead-elim remaps ctx helper side-tables in lockstep", () => {
  it("shifts helper-map entries down by the removed-import delta", () => {
    // Module: 2 func imports [0,1], 2 defined funcs [2,3]. Import #0 is dead
    // (nothing calls funcIdx 0); import #1 (live_a) is called by the caller, so
    // it survives. Defined fn #3 (caller) calls live_a (1) and sibling helper
    // callee (2). After dead-elim removes import #0: live_a 1→0, callee 2→1,
    // caller 3→2.
    const mod: WasmModule = {
      types: [{ kind: "func", params: [], results: [] }],
      imports: [mkFuncImport("dead_import", 0), mkFuncImport("live_a", 0)],
      functions: [
        { name: "__helper_callee", typeIdx: 0, locals: [], body: [], exported: false },
        {
          name: "__helper_caller",
          typeIdx: 0,
          locals: [],
          body: [
            { op: "call", funcIdx: 1 } as never, // live_a (keeps import #1 live)
            { op: "call", funcIdx: 2 } as never, // sibling helper callee
          ],
          exported: true,
        },
      ],
      exports: [{ name: "__helper_caller", desc: { kind: "func", index: 3 } }],
      globals: [],
      elements: [],
      tags: [],
      declaredFuncRefs: [],
      memories: [],
      datas: [],
      startFuncIdx: undefined,
    } as unknown as WasmModule;
    const ctx = fakeCtx(mod);
    ctx.nativeStrHelpers.set("__helper_callee", 2);
    ctx.funcMap.set("__helper_caller", 3);
    ctx.funcMap.set("live_a", 1);
    ctx.pendingMethodTrampolines.push({ methodFuncIdx: 2, trampolineFuncIdx: 3 });

    eliminateDeadImports(mod, ctx as never);

    // dead_import @0 removed → everything ≥1 shifts down by 1.
    expect(ctx.nativeStrHelpers.get("__helper_callee")).toBe(1); // 2 → 1
    expect(ctx.funcMap.get("__helper_caller")).toBe(2); // 3 → 2
    expect(ctx.funcMap.get("live_a")).toBe(0); // 1 → 0
    expect(ctx.pendingMethodTrampolines[0]!.methodFuncIdx).toBe(1); // 2 → 1
    expect(ctx.pendingMethodTrampolines[0]!.trampolineFuncIdx).toBe(2); // 3 → 2

    // And the module itself agrees: the helper caller's sibling call now points
    // at the relocated callee — so map and module never disagree.
    const caller = mod.functions.find((f) => (f as { name?: string }).name === "__helper_caller")!;
    const calls = caller.body.filter((i) => (i as { op: string }).op === "call") as { funcIdx: number }[];
    expect(calls.map((c) => c.funcIdx)).toEqual([0, 1]); // live_a@0, callee@1
  });

  it("is a no-op when no dead func import is removed (fR empty)", () => {
    const mod: WasmModule = {
      types: [{ kind: "func", params: [], results: [] }],
      imports: [mkFuncImport("live", 0)],
      functions: [
        {
          name: "__h",
          typeIdx: 0,
          locals: [],
          body: [{ op: "call", funcIdx: 0 } as never],
          exported: true,
        },
      ],
      exports: [{ name: "__h", desc: { kind: "func", index: 1 } }],
      globals: [],
      elements: [],
      tags: [],
      declaredFuncRefs: [],
      memories: [],
      datas: [],
      startFuncIdx: undefined,
    } as unknown as WasmModule;
    const ctx = fakeCtx(mod);
    ctx.nativeStrHelpers.set("__h", 1);
    eliminateDeadImports(mod, ctx as never);
    expect(ctx.nativeStrHelpers.get("__h")).toBe(1); // unchanged
  });

  it("idempotent: a second pass changes nothing", () => {
    const mod: WasmModule = {
      types: [{ kind: "func", params: [], results: [] }],
      imports: [mkFuncImport("dead", 0), mkFuncImport("live", 0)],
      functions: [
        { name: "__cal", typeIdx: 0, locals: [], body: [{ op: "call", funcIdx: 1 } as never], exported: true },
      ],
      exports: [{ name: "__cal", desc: { kind: "func", index: 2 } }],
      globals: [],
      elements: [],
      tags: [],
      declaredFuncRefs: [],
      memories: [],
      datas: [],
      startFuncIdx: undefined,
    } as unknown as WasmModule;
    const ctx = fakeCtx(mod);
    ctx.funcMap.set("__cal", 2);
    eliminateDeadImports(mod, ctx as never);
    const after1 = ctx.funcMap.get("__cal");
    eliminateDeadImports(mod, ctx as never); // no dead imports left → fR empty
    expect(ctx.funcMap.get("__cal")).toBe(after1);
  });

  it("reports the exact complete type layout before removing a middle type", () => {
    const previousTypes: WasmModule["types"] = [
      {
        kind: "func",
        params: [{ kind: "ref", typeIdx: 2 }],
        results: [],
      },
      { kind: "struct", name: "dead-middle", fields: [] },
      { kind: "struct", name: "live-capture", fields: [] },
    ];
    const mod: WasmModule = {
      types: previousTypes,
      imports: [],
      functions: [{ name: "live", typeIdx: 0, locals: [], body: [], exported: true }],
      exports: [{ name: "live", desc: { kind: "func", index: 0 } }],
      globals: [],
      elements: [],
      tags: [],
      declaredFuncRefs: [],
      memories: [],
      datas: [],
      startFuncIdx: undefined,
    } as unknown as WasmModule;
    const applyTypeLayoutRemap = vi.fn(
      (layout: {
        previousTypes: readonly unknown[];
        nextTypes: readonly unknown[];
        targetsByOldIndex: readonly (number | null)[];
      }) => {
        expect(mod.types).toBe(previousTypes);
        expect(layout.previousTypes).toBe(previousTypes);
        expect(layout.nextTypes).not.toBe(previousTypes);
      },
    );
    const ctx = {
      ...fakeCtx(mod),
      programAbiSession: { applyTypeLayoutRemap },
    };

    eliminateDeadImports(mod, ctx as never);

    expect(applyTypeLayoutRemap).toHaveBeenCalledTimes(1);
    const layout = applyTypeLayoutRemap.mock.calls[0]![0];
    expect(layout.previousTypes).toBe(previousTypes);
    expect(layout.nextTypes).toBe(mod.types);
    expect(layout.targetsByOldIndex).toEqual([0, null, 1]);
    expect(mod.types).toHaveLength(2);
    expect(mod.types[0]).toMatchObject({
      kind: "func",
      params: [{ kind: "ref", typeIdx: 1 }],
    });
    expect(mod.types[1]).toMatchObject({ kind: "struct", name: "live-capture" });
  });

  it("leaves the whole module unchanged when ABI type-layout validation rejects", () => {
    const previousTypes: WasmModule["types"] = [
      { kind: "func", params: [], results: [] },
      { kind: "struct", name: "dead-type", fields: [] },
    ];
    const previousImports = [mkFuncImport("dead", 0)];
    const mod: WasmModule = {
      types: previousTypes,
      imports: previousImports,
      functions: [{ name: "live", typeIdx: 0, locals: [], body: [], exported: true }],
      exports: [{ name: "live", desc: { kind: "func", index: 1 } }],
      globals: [],
      elements: [],
      tags: [],
      declaredFuncRefs: [],
      memories: [],
      datas: [],
      startFuncIdx: undefined,
    } as unknown as WasmModule;
    const snapshot = structuredClone(mod);
    const rejection = new Error("reject ABI type layout");
    const ctx = {
      ...fakeCtx(mod),
      programAbiSession: {
        applyTypeLayoutRemap: vi.fn(() => {
          throw rejection;
        }),
      },
    };

    expect(() => eliminateDeadImports(mod, ctx as never)).toThrow(rejection);
    expect(mod).toEqual(snapshot);
    expect(mod.types).toBe(previousTypes);
    expect(mod.imports).toBe(previousImports);
    expect(ctx.programAbiSession.applyTypeLayoutRemap).toHaveBeenCalledTimes(1);
  });
});

// --- (b) integration: known churning programs still compile/validate/run ---

async function compileValidate(src: string, target: "standalone" | "wasi" | "gc") {
  const r = await compile(src, { target });
  const hardErrors = (r.errors ?? []).filter((e) => (e as { severity?: string }).severity !== "warning");
  expect(hardErrors).toEqual([]);
  // Validates the binary; throws on a stale-funcIdx invalid module. The GC path
  // imports the JS-host `wasm:js-string` namespace, so it can only be compiled
  // (not instantiated with empty imports) here — that still exercises the
  // funcIdx-validity check, which is what #1899 is about.
  await WebAssembly.compile(r.binary);
  return r;
}

async function compileValidateRun(src: string, target: "standalone" | "wasi") {
  const r = await compileValidate(src, target);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return instance.exports as Record<string, () => unknown>;
}

describe("#1899 churning string/closure programs stay valid across targets", () => {
  // Closure-assign + native-string helpers in one module: triggers the
  // finalize-import ADD (the `let g: any` undefined-init path) AND exercises
  // sibling-calling string helpers (`+` → __str_concat → __str_flatten →
  // __str_copy_tree). Dead-elim then removes the speculative-but-unused string
  // imports, exercising the REMOVE direction the #1899 fix covers.
  const churn = `let g: any; g = function (): string { return "ab".slice(1) + "x".repeat(2); };
export function test(): number { return (g() as string).length; }`;

  for (const target of ["standalone", "wasi", "gc"] as const) {
    it(`closure-assign + string helpers compiles + validates [${target}]`, async () => {
      await compileValidate(churn, target);
    });
  }

  it("runs and returns the right length (standalone)", async () => {
    const exp = await compileValidateRun(churn, "standalone");
    expect((exp.test as () => number)()).toBe(3); // "b" + "xx"
  });

  // case-convert helpers (toLowerCase/toUpperCase) live behind the #40/#2191
  // public-name re-point that this issue's investigation surfaced — exercise
  // them under churn to keep that re-point + the new dead-elim ctx-remap honest.
  const caseChurn = `let h: any; h = function (): string { return "AbC".toLowerCase() + "dEf".toUpperCase(); };
export function test(): number { return (h() as string).length; }`;
  for (const target of ["standalone", "wasi"] as const) {
    it(`toLowerCase/toUpperCase under closure churn [${target}]`, async () => {
      const exp = await compileValidateRun(caseChurn, target);
      expect((exp.test as () => number)()).toBe(6); // "abc" + "DEF"
    });
  }
});
