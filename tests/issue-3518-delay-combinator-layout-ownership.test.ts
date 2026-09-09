// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
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
import * as delay from "../src/codegen/ir-native-promise-delay.js";
import * as all from "../src/codegen/ir-native-async-runtime.js";
import { getOrCreateFuncRefWrapperTypes } from "../src/codegen/closures.js";
import { definedFuncAt } from "../src/codegen/func-space.js";
import { ensureLateImport, flushLateImportShifts } from "../src/codegen/expressions/late-imports.js";
import { verifyHistorical } from "./helpers/native-delay-combinator-source-receipts.mjs";

void compile;
const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
import {
  B1_DONOR_HASHES as hashes,
  B1_INVERSE_ROWS as inverseRows,
  originalB1Source,
} from "./helpers/native-delay-combinator-b1-inverse.mjs";

function original(path: string, reader = read): string {
  return originalB1Source(path, reader);
}

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

function delayContext() {
  const ctx = context();
  const externref = { kind: "externref" } as const;
  const timer = ensureLateImport(ctx, "__timer_set_timeout", [externref, externref], [externref], "env");
  if (timer === undefined) throw new Error("missing actual delay timer import");
  flushLateImportShifts(ctx, null);
  expect(ctx.funcMap.get("__timer_set_timeout")).toBe(timer);
  return ctx;
}

// Execute independently reconstructed complete old adapters with actual dependencies.
// No candidate factory is injected into the old side, and no files are written.
async function oldModule<T>(path: string, overrides: Record<string, object> = {}): Promise<T> {
  const source = original(path);
  const syntax = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const imports: Record<string, object> = { ...overrides };
  for (const statement of syntax.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      statement.importClause?.isTypeOnly ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      continue;
    const specifier = statement.moduleSpecifier.text;
    if (specifier in imports) continue;
    const url = new URL(specifier.replace(/\.js$/, ".ts"), new URL(`../${path}`, import.meta.url));
    imports[specifier] = await import(/* @vite-ignore */ url.href);
  }
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  runInNewContext(
    output,
    {
      module,
      exports: module.exports,
      require: (name: string) => {
        if (!(name in imports)) throw new Error(`unbound original dependency: ${name}`);
        return imports[name];
      },
    },
    { filename: path },
  );
  return module.exports as T;
}

function trace(ctx: ReturnType<typeof context>) {
  return {
    module: ctx.mod,
    functions: [...ctx.funcMap],
    structs: [...ctx.structMap],
    names: [...ctx.typeIdxToStructName],
    fields: [...ctx.structFields],
    wrappers: [...ctx.funcRefWrapperCache],
    closureInfo: [...ctx.closureInfoByTypeIdx],
    minimumArguments: [...ctx.closureMinimumArgumentCountByFuncTypeIdx],
    functionTypes: [...ctx.funcTypeCache],
    arrays: [...ctx.arrayTypeMap],
  };
}
afterEach(() => vi.restoreAllMocks());

describe("B1 exact donor route", () => {
  it("reconstructs all three complete adapters and retains the original donor denominator", () => {
    for (const path of Object.keys(hashes)) expect(original(path).length).toBeGreaterThan(1000);
    expect(verifyHistorical(read)).toEqual({
      historicalDonors: 8,
      delayRows: 4,
      vectorLoops: 1,
      sharedDispatchHelpers: 1,
    });
  });
  for (const path of Object.keys(hashes)) {
    it(`rejects a live import/comment/order mutation in ${path}`, () => {
      expect(() => original(path, (file) => read(file) + "\n// unaccounted mutation\n")).toThrow();
    });
  }
  for (const [index, row] of inverseRows.entries()) {
    it(`rejects removal of live B1 bridge ${index}`, () => {
      expect(read(row.path).includes(row.before)).toBe(true);
      expect(() => original(row.path, (path) => read(path).replace(row.before, ""))).toThrow();
    });
  }
});

describe("canonical full-reference layouts and local placement", () => {
  it("keeps the canonical factory independent of legacy registration owners", () => {
    const source = read("src/runtime/wasmgc/promise/delay-combinator-layouts.ts");
    const syntax = ts.createSourceFile("layouts.ts", source, ts.ScriptTarget.Latest, true);
    const imports = syntax.statements.filter(ts.isImportDeclaration);
    expect(imports.map((node) => (node.moduleSpecifier as ts.StringLiteral).text)).toEqual([
      "../../../wasm/model/instructions.js",
      "../values/closure-layouts.js",
      "./combinator-bodies.js",
    ]);
    expect(imports.map((node) => node.importClause?.isTypeOnly)).toEqual([true, false, true]);
  });
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
  for (const method of ["all", "race", "allSettled", "any"] as const) {
    it(`retains nonzero localMap/allocLocal effects for the actual ${method} caller`, async () => {
      const old = await oldModule<typeof combinators>("src/codegen/promise-combinators.ts");
      const before = context(),
        after = context();
      const makeFunction = (): FunctionContext => ({
        name: "b1-nonzero",
        params: [
          { name: "unused", type: { kind: "i32" } },
          { name: "arg", type: { kind: "externref" } },
        ],
        locals: [{ name: "existing", type: { kind: "i32" } }],
        localMap: new Map([
          ["unused", 0],
          ["arg", 1],
          ["existing", 2],
        ]),
        returnType: { kind: "externref" },
        body: [{ op: "nop" }],
        blockDepth: 0,
        breakStack: [],
        continueStack: [],
        labelMap: new Map(),
        savedBodies: [],
      });
      const oldFunction = makeFunction(),
        newFunction = makeFunction();
      before.currentFunc = oldFunction;
      after.currentFunc = newFunction;
      const oldIds = old.ensureCombinatorFunctions(before);
      const newIds = combinators.ensureCombinatorFunctions(after);
      const locals = newFunction.locals,
        map = newFunction.localMap,
        body = newFunction.body;
      const factory = vi.spyOn(layouts, "buildNativeAllProviderLocals");
      old.emitStandalonePromiseCombinatorRuntime(before, oldFunction, method, 1, oldIds.vecTypeIdx, oldIds.arrTypeIdx);
      combinators.emitStandalonePromiseCombinatorRuntime(
        after,
        newFunction,
        method,
        1,
        newIds.vecTypeIdx,
        newIds.arrTypeIdx,
      );
      expect(factory).toHaveBeenCalledTimes(1);
      expect(factory.mock.calls[0]?.[3]).toEqual({ parameterCount: 2, firstLocalOrdinal: 1, argVecLocal: 1 });
      expect(newFunction).toEqual(oldFunction);
      expect(newFunction.locals).toBe(locals);
      expect(newFunction.localMap).toBe(map);
      expect(newFunction.body).toBe(body);
      expect([...map]).toEqual([
        ["unused", 0],
        ["arg", 1],
        ["existing", 2],
        ["__comb_result_1", 3],
        ["__comb_arr_2", 4],
        ["__comb_state_3", 5],
        ["__comb_n_4", 6],
        ["__comb_i_5", 7],
      ]);
      expect(trace(after)).toEqual(trace(before));
    });
  }
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
  it("retains combinator module/registry traces and allocation-free cache hits", async () => {
    const old = await oldModule<typeof combinators>("src/codegen/promise-combinators.ts");
    const before = context(),
      after = context();
    const state = vi.spyOn(layouts, "createNativeCombinatorStateShape");
    const element = vi.spyOn(layouts, "createNativeCombinatorElementShape");
    const oldIds = old.ensureCombinatorFunctions(before);
    const newIds = combinators.ensureCombinatorFunctions(after);
    expect(newIds).toEqual(oldIds);
    expect(trace(after)).toEqual(trace(before));
    expect(state).toHaveBeenCalledTimes(1);
    expect(element).toHaveBeenCalledTimes(1);
    for (const [name, typeIdx] of [
      ["$CombinatorState", newIds.stateTypeIdx],
      ["$CombinatorElemCaps", newIds.elemCapsTypeIdx],
    ] as const) {
      const descriptor = after.mod.types[typeIdx];
      expect(descriptor?.kind).toBe("struct");
      if (descriptor?.kind !== "struct") throw new Error("missing registered carrier");
      expect(after.structMap.get(name)).toBe(typeIdx);
      expect(after.typeIdxToStructName.get(typeIdx)).toBe(name);
      expect(after.structFields.get(name)).toEqual(descriptor.fields);
      expect(Object.hasOwn(descriptor, "superTypeIdx")).toBe(false);
    }
    expect(combinators.ensureCombinatorFunctions(after)).toBe(newIds);
    expect(old.ensureCombinatorFunctions(before)).toBe(oldIds);
    expect(state).toHaveBeenCalledTimes(1);
    expect(element).toHaveBeenCalledTimes(1);
    expect(trace(after)).toEqual(trace(before));
  });
  it("retains delay registration, host-one-shot wrapper observation and cached handle", async () => {
    const old = await oldModule<typeof delay>("src/codegen/ir-native-promise-delay.ts");
    const before = delayContext(),
      after = delayContext();
    const factory = vi.spyOn(layouts, "createNativeDelayCaptureShape");
    const oldId = old.ensureIrNativePromiseDelayProvider(before);
    const newId = delay.ensureIrNativePromiseDelayProvider(after);
    expect(newId).toBe(oldId);
    expect(trace(after)).toEqual(trace(before));
    expect(factory).toHaveBeenCalledTimes(1);
    expect(delay.ensureIrNativePromiseDelayProvider(after)).toBe(newId);
    expect(old.ensureIrNativePromiseDelayProvider(before)).toBe(oldId);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(trace(after)).toEqual(trace(before));
  });
  it("retains dedicated all locals, body, single appended return and restoration", async () => {
    const oldCombinators = await oldModule<typeof combinators>("src/codegen/promise-combinators.ts");
    const old = await oldModule<typeof all>("src/codegen/ir-native-async-runtime.ts", {
      "./promise-combinators.js": oldCombinators,
    });
    const before = context(),
      after = context();
    const previous = enclosingFunction();
    after.currentFunc = previous;
    before.currentFunc = enclosingFunction();
    const provider = all.ensureIrNativePromiseAllProvider(after);
    expect(provider).toBe(old.ensureIrNativePromiseAllProvider(before));
    expect(after.currentFunc).toBe(previous);
    expect(trace(after)).toEqual(trace(before));
    const emitted = definedFuncAt(after, provider);
    expect(emitted).toBeDefined();
    expect(emitted?.locals.map((local) => local.name)).toEqual([
      "__comb_result_0",
      "__comb_arr_1",
      "__comb_state_2",
      "__comb_n_3",
      "__comb_i_4",
    ]);
    expect(emitted?.body.at(-1)).toEqual({ op: "return" });
    expect(emitted?.body.filter((instruction) => instruction.op === "return")).toHaveLength(1);
    const count = after.mod.functions.length;
    all.ensureIrNativePromiseAllProvider(after);
    expect(after.mod.functions).toHaveLength(count);
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
  it("preserves an existing zeroarg wrapper identity and its observation on delay registration", async () => {
    const old = await oldModule<typeof delay>("src/codegen/ir-native-promise-delay.ts");
    const before = delayContext(),
      after = delayContext();
    const oldWrapper = getOrCreateFuncRefWrapperTypes(before, [], [], "support");
    const newWrapper = getOrCreateFuncRefWrapperTypes(after, [], [], "support");
    if (!oldWrapper || !newWrapper) throw new Error("missing positive zeroarg wrapper");
    const oldInfo = oldWrapper.closureInfo,
      newInfo = newWrapper.closureInfo;
    old.ensureIrNativePromiseDelayProvider(before);
    delay.ensureIrNativePromiseDelayProvider(after);
    expect(after.closureInfoByTypeIdx.get(newWrapper.structTypeIdx)).toBe(newInfo);
    expect(before.closureInfoByTypeIdx.get(oldWrapper.structTypeIdx)).toBe(oldInfo);
    expect(trace(after)).toEqual(trace(before));
    const capture = after.mod.types.find(
      (type) => type.kind === "struct" && type.name === "$__ir_promise_delay_timer_cap",
    );
    expect(capture?.kind).toBe("struct");
    if (capture?.kind !== "struct") throw new Error("missing delay capture");
    expect(capture.superTypeIdx).toBe(newWrapper.structTypeIdx);
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
