// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it, vi } from "vitest";
// Initialize the compiler graph before importing its context adapters.
import { compile } from "../src/index.js";
import { analyzeSource } from "../src/checker/index.js";
import { createEmptyModule, type Instr, type ValType } from "../src/ir/types.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import type { CodegenContext, FunctionContext } from "../src/codegen/context/types.js";
import * as legacy from "../src/codegen/promise-combinators.js";
import * as protocol from "../src/codegen/promise-combinator-observable-protocol.js";
import * as separate from "../src/codegen/promise-observable-combinators.js";
import * as scheduler from "../src/codegen/async-scheduler.js";
import { getOrRegisterVecType } from "../src/codegen/registry/types.js";

function context(): CodegenContext {
  const source = analyzeSource("export function test(): number { return 1; }", "protocol-context.ts");
  return createCodegenContext(createEmptyModule(), source.checker, { standalone: true, nativeStrings: true });
}

function functionContext(): FunctionContext {
  return {
    name: "protocol",
    params: [],
    locals: [],
    localMap: new Map(),
    returnType: { kind: "externref" },
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };
}

function registrationSnapshot(ctx: CodegenContext) {
  return structuredClone({
    module: ctx.mod,
    functions: [...ctx.funcMap],
    structs: [...ctx.structMap],
    fields: [...ctx.structFields],
    typeNames: [...ctx.typeIdxToStructName],
  });
}

afterEach(() => vi.restoreAllMocks());

describe("relocated observable protocol preservation", () => {
  for (const vector of [false, true]) {
    for (const unavailable of ["cached", "cold"] as const) {
      it(`keeps ${vector ? "vector" : "literal"} fallback registration and emission, ${unavailable} failure`, () => {
        const ctx = context();
        const ids = legacy.ensureCombinatorFunctions(ctx);
        if (unavailable === "cached") {
          (ctx as CodegenContext & { __promiseObservableCombinators: null }).__promiseObservableCombinators = null;
        } else {
          vi.spyOn(scheduler, "ensurePromiseExecutorClosures").mockReturnValue(null);
        }
        const actual = functionContext();
        const expected = functionContext();
        let checked = 0;
        // Capture the REAL registration state immediately before delegation.
        // Repeated ensures must keep every definition, map, index and cache
        // identity, and the actual fallback must emit the original instructions.
        const check = () => {
          const before = registrationSnapshot(ctx);
          const runtime = scheduler.ensureAsyncDriveRuntime(ctx);
          expect(legacy.ensureCombinatorFunctions(ctx)).toBe(ids);
          expect(scheduler.ensureAsyncDriveRuntime(ctx)).toEqual(runtime);
          expect(registrationSnapshot(ctx)).toEqual(before);
          checked++;
        };
        if (vector) {
          const original = legacy.emitStandalonePromiseCombinatorRuntime;
          const rejectReason: Instr[] = [{ op: "ref.null.extern" }];
          const rejection = { notIterLocal: 0, rejectReason };
          vi.spyOn(legacy, "emitStandalonePromiseCombinatorRuntime").mockImplementation((...args) => {
            check();
            expect(args[6]).toEqual(rejection);
            const result = original(...args);
            original(ctx, expected, "all", 0, ids.vecTypeIdx, ids.arrTypeIdx, rejection);
            return result;
          });
          protocol.emitStandalonePromiseCombinatorRuntime(ctx, actual, "all", 0, ids.vecTypeIdx, ids.arrTypeIdx, {
            ...rejection,
            observableResolve: true,
            boxF64Elements: true,
          });
        } else {
          const original = legacy.emitStandalonePromiseCombinator;
          const input: Instr[][] = [[{ op: "ref.null.extern" }]];
          vi.spyOn(legacy, "emitStandalonePromiseCombinator").mockImplementation((...args) => {
            check();
            const result = original(...args);
            original(ctx, expected, "all", input);
            return result;
          });
          protocol.emitStandalonePromiseCombinator(ctx, actual, "all", input, { observableResolve: true });
        }
        expect(checked).toBe(1);
        expect(actual).toEqual(expected);
        expect(
          (ctx as CodegenContext & { __promiseObservableCombinators: null }).__promiseObservableCombinators,
        ).toBeNull();
      });
    }
  }

  it("ordinary wrappers delegate before registering anything and preserve incomplete rejection-pair narrowing", () => {
    const ctx = context();
    const before = registrationSnapshot(ctx);
    const literal = vi.spyOn(legacy, "emitStandalonePromiseCombinator").mockImplementation(() => {
      expect(registrationSnapshot(ctx)).toEqual(before);
      return { kind: "externref" };
    });
    const vector = vi.spyOn(legacy, "emitStandalonePromiseCombinatorRuntime").mockImplementation((...args) => {
      expect(registrationSnapshot(ctx)).toEqual(before);
      expect(args[6]).toBeUndefined();
      return { kind: "externref" };
    });
    protocol.emitStandalonePromiseCombinator(ctx, functionContext(), "all", []);
    protocol.emitStandalonePromiseCombinatorRuntime(ctx, functionContext(), "all", 0, 0, 0, { notIterLocal: 0 });
    // An observable flag must not admit allSettled/any into an all/race protocol.
    protocol.emitStandalonePromiseCombinator(ctx, functionContext(), "any", [], { observableResolve: true });
    expect(literal).toHaveBeenCalledTimes(2);
    expect(vector).toHaveBeenCalledTimes(1);
  });

  it("shares one f64 admission decision without changing accepted or rejected carriers", () => {
    const ctx = context();
    const f64 = getOrRegisterVecType(ctx, "f64", { kind: "f64" });
    const ext = getOrRegisterVecType(ctx, "externref", { kind: "externref" });
    const classify = vi.spyOn(protocol, "resolveF64VecArg");
    const rejected: (ValType | null)[] = [
      null,
      { kind: "externref" },
      { kind: "f64" },
      { kind: "ref", typeIdx: -1 },
      { kind: "ref", typeIdx: ext },
      { kind: "ref", typeIdx: 999999 },
    ];
    for (const type of rejected) expect(separate.resolveF64VecArg(ctx, type)).toBeNull();
    for (const kind of ["ref", "ref_null"] as const) {
      const result = separate.resolveF64VecArg(ctx, { kind, typeIdx: f64 });
      expect(result?.vecTypeIdx).toBe(f64);
      expect(ctx.mod.types[result!.arrTypeIdx].kind).toBe("array");
    }
    expect(classify).toHaveBeenCalledTimes(rejected.length + 2);
    ctx.typeIdxToStructName.set(f64, "not_a_vec");
    expect(separate.resolveF64VecArg(ctx, { kind: "ref", typeIdx: f64 })).toBeNull();
  });

  for (const method of ["all", "race"] as const) {
    for (const vector of [false, true]) {
      it(`executes retained main ${method} ${vector ? "f64-vector" : "literal"} protocol`, async () => {
        // Exercise the retained main entrypoint through the real compiler at
        // precisely the separate route's existing source-admitted call site.
        const literal = vi
          .spyOn(separate, "emitObservableStandalonePromiseCombinatorLiteral")
          .mockImplementation((ctx, fctx, name, elements) =>
            protocol.emitStandalonePromiseCombinator(ctx, fctx, name, elements, { observableResolve: true }),
          );
        const runtime = vi
          .spyOn(separate, "emitObservableStandalonePromiseCombinatorRuntime")
          .mockImplementation((ctx, fctx, name, local, vec, arr, options) =>
            protocol.emitStandalonePromiseCombinatorRuntime(ctx, fctx, name, local, vec, arr, {
              ...options,
              observableResolve: true,
            }),
          );
        const classify = vi.spyOn(protocol, "resolveF64VecArg");
        const source = `
declare function __drain_microtasks(): void;
export function test(): number {
  const values: number[] = [2, 3];
  (Promise as any).resolve = function(v: any): any {
    if (v === 2) values[1] = 7;
    return { then: function(ok: any): void { ok(v); ok(99); } };
  };
  let result = -1;
  Promise.${method}(${vector ? "values" : "[2, 3]"}).then(function(v: any): void {
    result = ${method === "all" ? "v[0] * 10 + v[1]" : "v"};
  });
  __drain_microtasks();
  return result;
}`;
        const result = await compile(source, {
          fileName: "protocol-relocation.ts",
          target: "standalone",
          nativeStrings: true,
        });
        expect(result.success, JSON.stringify(result.errors)).toBe(true);
        const module = await WebAssembly.compile(result.binary);
        expect(WebAssembly.Module.imports(module)).toEqual([]);
        const instance = await WebAssembly.instantiate(module, {});
        expect((instance.exports.test as () => number)()).toBe(method === "race" ? 2 : vector ? 27 : 23);
        expect(vector ? runtime : literal).toHaveBeenCalled();
        if (vector) expect(classify.mock.results.some((row) => row.value !== null)).toBe(true);
      });
    }
  }
});
