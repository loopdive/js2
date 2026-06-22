// #1919 — transactional speculative-compile API.
//
// The probe-compile-and-rollback idiom (compile an expression to inspect its
// type, then truncate `fctx.body.length` to undo) leaked locals, late imports,
// and errors on rollback — restoring only the body. A late import leaked by a
// rolled-back probe is the worst: it stays in `mod.imports` and shifts every
// later function index (#1916 interaction). These tests pin the helper's
// contract (`snapshotSpeculative`/`rollbackSpeculative`) directly, plus an
// end-to-end compile whose probe path used to leak.
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { compile } from "../src/index.js";
import { createEmptyModule } from "../src/ir/types.js";
import { createCodegenContext } from "../src/codegen/index.js";
import { allocLocal } from "../src/codegen/context/locals.js";
import { ensureLateImport, flushLateImportShifts } from "../src/codegen/expressions/late-imports.js";
import {
  snapshotSpeculative,
  rollbackSpeculative,
  withSpeculativeCompile,
  probeCompiledType,
} from "../src/codegen/context/speculative.js";
import type { CodegenContext, FunctionContext } from "../src/codegen/context/types.js";

function makeFctx(): FunctionContext {
  return {
    name: "test",
    params: [],
    locals: [],
    localMap: new Map<string, number>(),
    returnType: null,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  } as unknown as FunctionContext;
}

function makeCtx(): CodegenContext {
  const mod = createEmptyModule();
  // createCodegenContext only needs the checker object to exist for these paths.
  return createCodegenContext(mod, {} as unknown as ts.TypeChecker);
}

describe("#1919 — rollbackSpeculative unwinds body + locals + late imports + errors", () => {
  it("pops a late import registered during the rolled-back region", () => {
    const ctx = makeCtx();
    const fctx = makeFctx();

    // A pre-existing import — must survive rollback untouched. Flush its pending
    // shift so the snapshot starts from a clean (null) deferred-shift latch,
    // isolating the probe's effect on `pendingLateImportShift`.
    ensureLateImport(ctx, "__pre_existing", [{ kind: "i32" }], [{ kind: "i32" }]);
    ctx.pendingLateImportShift = null; // pretend the pre-existing shift was flushed
    const importsBefore = ctx.mod.imports.length;
    const numImportFuncsBefore = ctx.numImportFuncs;

    const snap = snapshotSpeculative(ctx, fctx);
    expect(snap.pendingLateImportShift).toBeNull();

    // Probe registers a NEW late import + emits a body instr + a local + an error.
    const phantomIdx = ensureLateImport(ctx, "__phantom_probe", [{ kind: "f64" }], [{ kind: "externref" }]);
    expect(phantomIdx).toBeDefined();
    expect(ctx.funcMap.has("__phantom_probe")).toBe(true);
    expect(ctx.mod.imports.length).toBe(importsBefore + 1);
    expect(ctx.numImportFuncs).toBe(numImportFuncsBefore + 1);
    fctx.body.push({ op: "call", funcIdx: phantomIdx! });
    allocLocal(fctx, "__probe_local", { kind: "i32" });
    ctx.errors.push({ message: "probe diagnostic", line: 0, column: 0, severity: "error" });

    rollbackSpeculative(ctx, fctx, snap);

    // The phantom import is gone — funcMap, mod.imports, and numImportFuncs all
    // back to the snapshot, so no later function index would be shifted by it.
    expect(ctx.funcMap.has("__phantom_probe")).toBe(false);
    expect(ctx.mod.imports.length).toBe(importsBefore);
    expect(ctx.numImportFuncs).toBe(numImportFuncsBefore);
    // The pre-existing import is untouched.
    expect(ctx.funcMap.has("__pre_existing")).toBe(true);
    // Body, locals, errors all restored.
    expect(fctx.body.length).toBe(0);
    expect(fctx.localMap.has("__probe_local")).toBe(false);
    expect(ctx.errors.length).toBe(0);
    // The deferred-shift latch is back to its pre-probe value (null) so the next
    // real flush computes its delta from a clean base.
    expect(ctx.pendingLateImportShift).toBeNull();
  });

  it("re-registering the same import name after rollback gets a fresh, contiguous index", () => {
    const ctx = makeCtx();
    const fctx = makeFctx();
    const snap = snapshotSpeculative(ctx, fctx);
    const probeIdx = ensureLateImport(ctx, "__box_x", [{ kind: "f64" }], [{ kind: "externref" }]);
    rollbackSpeculative(ctx, fctx, snap);
    // After rollback the name is free again; re-registering yields the same slot
    // it would have had if the probe never ran (no phantom gap in the index space).
    const committedIdx = ensureLateImport(ctx, "__box_x", [{ kind: "f64" }], [{ kind: "externref" }]);
    expect(committedIdx).toBe(probeIdx);
    expect(ctx.numImportFuncs).toBe(1);
    expect(ctx.mod.imports.length).toBe(1);
  });

  it("withSpeculativeCompile keeps state on commit, discards it on rollback", () => {
    const ctx = makeCtx();
    const fctx = makeFctx();

    // commit: true keeps the registered import.
    const kept = withSpeculativeCompile(ctx, fctx, () => {
      const idx = ensureLateImport(ctx, "__kept", [], [{ kind: "i32" }]);
      return { commit: true, value: idx };
    });
    expect(kept).toBeDefined();
    expect(ctx.funcMap.has("__kept")).toBe(true);

    // commit: false discards it.
    const discarded = withSpeculativeCompile(ctx, fctx, () => {
      const idx = ensureLateImport(ctx, "__discarded", [], [{ kind: "i32" }]);
      return { commit: false, value: idx };
    });
    expect(discarded).toBeDefined(); // value still returned for inspection
    expect(ctx.funcMap.has("__discarded")).toBe(false);
  });

  it("withSpeculativeCompile rolls back when fn throws, then re-throws", () => {
    const ctx = makeCtx();
    const fctx = makeFctx();
    const importsBefore = ctx.mod.imports.length;
    expect(() =>
      withSpeculativeCompile(ctx, fctx, () => {
        ensureLateImport(ctx, "__throws", [], [{ kind: "i32" }]);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    // The import registered before the throw is unwound.
    expect(ctx.funcMap.has("__throws")).toBe(false);
    expect(ctx.mod.imports.length).toBe(importsBefore);
  });

  it("keeps the import (no corruption) when the probe FLUSHED its shift mid-region", () => {
    // If a probe eagerly flushes (some emit helpers do), committed func bodies
    // were already shifted UP and there is no cheap inverse. Rollback must then
    // KEEP the import registered (pre-#1919 behaviour) rather than pop the count
    // and leave indices desynced. Simulate a flush after the import is added.
    const ctx = makeCtx();
    const fctx = makeFctx();
    const importsBefore = ctx.mod.imports.length;
    const snap = snapshotSpeculative(ctx, fctx);
    ensureLateImport(ctx, "__flushed_probe", [], [{ kind: "i32" }]);
    flushLateImportShifts(ctx, fctx); // probe flushed → pendingLateImportShift = null
    expect(ctx.pendingLateImportShift).toBeNull();
    rollbackSpeculative(ctx, fctx, snap);
    // The import is KEPT (popping it would desync the already-shifted indices).
    expect(ctx.funcMap.has("__flushed_probe")).toBe(true);
    expect(ctx.mod.imports.length).toBe(importsBefore + 1);
    // Body + locals + errors are still rolled back (those are always safe).
    expect(fctx.body.length).toBe(0);
  });

  it("probeCompiledType always rolls back and returns the probe's value", () => {
    const ctx = makeCtx();
    const fctx = makeFctx();
    const importsBefore = ctx.mod.imports.length;
    const result = probeCompiledType(ctx, fctx, () => {
      ensureLateImport(ctx, "__probe_only", [], [{ kind: "i32" }]);
      fctx.body.push({ op: "i32.const", value: 7 });
      return { kind: "i32" as const };
    });
    expect(result).toEqual({ kind: "i32" });
    // Always rolled back, regardless of return value.
    expect(ctx.funcMap.has("__probe_only")).toBe(false);
    expect(ctx.mod.imports.length).toBe(importsBefore);
    expect(fctx.body.length).toBe(0);
  });
});

describe("#1919 — end-to-end: a probe path that registers an import does not leak it", () => {
  it("Array.from(<string>) over a non-native-string arg compiles to a valid module", async () => {
    // The Array.from native-string probe (calls.ts) tentatively compiles the arg
    // and rolls back when it is not a native string. If the rolled-back probe
    // leaked a late import, every later function index would shift and the module
    // would fail Wasm validation. A clean compile + instantiate proves no leak.
    const src = `
      export function test(): number {
        const a = Array.from([1, 2, 3]);
        const b = Array.from("xy");
        return a.length + b.length;
      }
    `;
    const r = await compile(src, { fileName: "t.ts" });
    expect(r.success).toBe(true);
    const importObject = (r as { importObject?: WebAssembly.Imports }).importObject ?? {};
    const { instance } = await WebAssembly.instantiate(r.binary, importObject);
    expect((instance.exports.test as () => number)()).toBe(5);
  });

  it("consecutive array method probes + for-of over the same array stay valid", async () => {
    // Exercises the array-method receiver probe (array-methods.ts) and the
    // tentative for-of path back-to-back; a leaked probe import would desync
    // indices between the two and fail validation.
    const src = `
      export function test(): number {
        const arr: number[] = [4, 5, 6];
        let total = arr.reduce((acc, x) => acc + x, 0);
        for (const v of arr) { total += v; }
        return total;
      }
    `;
    const r = await compile(src, { fileName: "t.ts" });
    expect(r.success).toBe(true);
    const importObject = (r as { importObject?: WebAssembly.Imports }).importObject ?? {};
    const { instance } = await WebAssembly.instantiate(r.binary, importObject);
    expect((instance.exports.test as () => number)()).toBe(30);
  });
});
