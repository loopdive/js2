// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it, vi } from "vitest";
import { compile } from "../src/index.js";
import { analyzeSource } from "../src/checker/index.js";
import { createEmptyModule } from "../src/ir/types.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import type { FunctionContext } from "../src/codegen/context/types.js";
import * as layouts from "../src/runtime/wasmgc/promise/delay-combinator-layouts.js";
import * as closure from "../src/runtime/wasmgc/values/closure-layouts.js";
import * as bodies from "../src/runtime/wasmgc/promise/combinator-bodies.js";
import * as combinators from "../src/codegen/promise-combinators.js";
import * as all from "../src/codegen/ir-native-async-runtime.js";

void compile;

function context() {
  const source = analyzeSource("export function main(): number { return 1; }", "b1-layout-ownership.ts");
  return createCodegenContext(createEmptyModule(), source.checker, { standalone: true, nativeStrings: true });
}

function enclosingFunction(): FunctionContext {
  return {
    name: "b1-enclosing-owner",
    params: [],
    locals: [],
    localMap: new Map(),
    returnType: null,
    body: [{ op: "nop" }],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };
}
afterEach(() => vi.restoreAllMocks());

describe("canonical full-reference layouts and local placement", () => {
  it("preserves every delay field, canonical header, reference identity and parent", () => {
    const wrapper = Object.freeze({ key: "zeroarg" }),
      promise = Object.freeze({ key: "promise" });
    const arity = vi.spyOn(closure, "closureArityField"),
      bag = vi.spyOn(closure, "closureBagField");
    const shape = layouts.createNativeDelayCaptureShape(wrapper, promise);
    expect(shape).toEqual({
      name: "$__ir_promise_delay_timer_cap",
      parent: wrapper,
      fields: [
        { name: "func", type: { kind: "funcref" }, mutable: false },
        { name: "$arity", type: { kind: "i32" }, mutable: false },
        { name: "$bag", type: { kind: "externref" }, mutable: true },
        { name: "promise", type: promise, mutable: false },
        { name: "value", type: { kind: "f64" }, mutable: false },
      ],
    });
    expect(shape.parent).toBe(wrapper);
    expect(shape.fields[3].type).toBe(promise);
    expect(arity).toHaveBeenCalledTimes(1);
    expect(bag).toHaveBeenCalledTimes(1);
    arity.mockReturnValue({ name: "wrong", type: { kind: "i32" }, mutable: false });
    expect(() => layouts.createNativeDelayCaptureShape(wrapper, promise)).toThrow("canonical named closure header");
  });
  it("preserves state/element order, mutable remaining, and absent parent keys", () => {
    const promise = { key: "promise" },
      array = { key: "array" },
      state = { key: "state" };
    const stateShape = layouts.createNativeCombinatorStateShape(promise, array);
    const element = layouts.createNativeCombinatorElementShape(state);
    expect(stateShape).toEqual({
      name: "$CombinatorState",
      fields: [
        { name: "resultPromise", type: promise, mutable: false },
        { name: "resultsArr", type: array, mutable: false },
        { name: "length", type: { kind: "i32" }, mutable: false },
        { name: "remaining", type: { kind: "i32" }, mutable: true },
      ],
    });
    expect(element).toEqual({
      name: "$CombinatorElemCaps",
      fields: [
        { name: "state", type: state, mutable: false },
        { name: "index", type: { kind: "i32" }, mutable: false },
      ],
    });
    expect(Object.hasOwn(stateShape, "parent")).toBe(false);
    expect(Object.hasOwn(element, "parent")).toBe(false);
    expect(stateShape.fields[0].type).toBe(promise);
    expect(stateShape.fields[1].type).toBe(array);
    expect(element.fields[0].type).toBe(state);
  });
  for (const [parameterCount, firstLocalOrdinal, argVecLocal] of [
    [1, 0, 0],
    [3, 4, 2],
  ]) {
    it(`preserves local ordinals and absolute slots at ${parameterCount}/${firstLocalOrdinal}`, () => {
      const placement = Object.freeze({ parameterCount, firstLocalOrdinal, argVecLocal });
      const plan = layouts.buildNativeAllProviderLocals(17, 23, 31, placement);
      const n = firstLocalOrdinal,
        first = parameterCount + n;
      expect(plan.locals).toEqual([
        { name: `__comb_result_${n}`, type: { kind: "ref", typeIdx: 17 } },
        { name: `__comb_arr_${n + 1}`, type: { kind: "ref", typeIdx: 23 } },
        { name: `__comb_state_${n + 2}`, type: { kind: "ref", typeIdx: 31 } },
        { name: `__comb_n_${n + 3}`, type: { kind: "i32" } },
        { name: `__comb_i_${n + 4}`, type: { kind: "i32" } },
      ]);
      expect(plan.slots).toEqual({
        argVecLocal,
        resultLocal: first,
        arrLocal: first + 1,
        stateLocal: first + 2,
        nLocal: first + 3,
        iLocal: first + 4,
      });
    });
  }
});

describe("independent old/new registration and provider observations", () => {
  it("rejects a live factory slot mutation at the actual allocation boundary", () => {
    const ctx = context();
    combinators.ensureCombinatorFunctions(ctx);
    const real = layouts.buildNativeAllProviderLocals;
    vi.spyOn(layouts, "buildNativeAllProviderLocals").mockImplementation((...args) => {
      const plan = real(...args);
      return { ...plan, slots: { ...plan.slots, resultLocal: plan.slots.resultLocal + 1 } };
    });
    expect(() => all.ensureIrNativePromiseAllProvider(ctx)).toThrow("local allocation diverged");
  });
  it("restores currentFunc and identical thrown sentinel without minting a failed provider", () => {
    const ctx = context();
    combinators.ensureCombinatorFunctions(ctx);
    const previous = enclosingFunction(),
      count = ctx.mod.functions.length;
    ctx.currentFunc = previous;
    const sentinel = new Error("B1 canonical body sentinel");
    vi.spyOn(bodies, "buildNativePromiseCombinatorVectorBody").mockImplementation(() => {
      throw sentinel;
    });
    let thrown: unknown;
    try {
      all.ensureIrNativePromiseAllProvider(ctx);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(sentinel);
    expect(ctx.currentFunc).toBe(previous);
    expect(ctx.mod.functions).toHaveLength(count);
  });
  for (const fault of ["population", "name", "reference", "localMap"] as const) {
    it(`rejects actual provider ${fault} corruption and restores the enclosing owner`, () => {
      const ctx = context(),
        previous = enclosingFunction();
      combinators.ensureCombinatorFunctions(ctx);
      ctx.currentFunc = previous;
      const count = ctx.mod.functions.length;
      const real = combinators.emitStandalonePromiseCombinatorRuntime;
      vi.spyOn(combinators, "emitStandalonePromiseCombinatorRuntime").mockImplementation((...args) => {
        real(...args);
        const fctx = args[1];
        if (fault === "population") fctx.locals.pop();
        else if (fault === "localMap") fctx.localMap.set("__comb_result_0", 2);
        else {
          const first = fctx.locals[0];
          if (!first) throw new Error("missing positive local");
          fctx.locals[0] =
            fault === "name" ? { ...first, name: "wrong" } : { ...first, type: { kind: "ref", typeIdx: 999999 } };
        }
      });
      expect(() => all.ensureIrNativePromiseAllProvider(ctx)).toThrow("lost its canonical local");
      expect(ctx.currentFunc).toBe(previous);
      expect(ctx.mod.functions).toHaveLength(count);
    });
  }
});
