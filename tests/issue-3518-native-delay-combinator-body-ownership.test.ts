// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Instr } from "../src/wasm/model/instructions.js";
import * as delay from "../src/runtime/wasmgc/promise/delay-bodies.js";
import * as combinator from "../src/runtime/wasmgc/promise/combinator-bodies.js";
// Bootstrap the actual historical graph before importing its context adapters.
import { compile } from "../src/index.js";
import { analyzeSource } from "../src/checker/index.js";
import { createEmptyModule } from "../src/ir/types.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import type { FunctionContext } from "../src/codegen/context/types.js";
import {
  ensureCombinatorFunctions,
  emitStandalonePromiseCombinatorRuntime,
} from "../src/codegen/promise-combinators.js";
import { ensureIrNativePromiseAllProvider } from "../src/codegen/ir-native-async-runtime.js";
import { ensureIrNativePromiseDelayProvider } from "../src/codegen/ir-native-promise-delay.js";
import { definedFuncAt, funcSignatureOf } from "../src/codegen/func-space.js";
import {
  ensureLateImport,
  flushLateImportShifts,
  shiftLateImportIndices,
} from "../src/codegen/expressions/late-imports.js";
import { shiftAsyncSideChannelFuncIdxs } from "../src/codegen/async-scheduler.js";

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const paths = ["src/runtime/wasmgc/promise/delay-bodies.ts", "src/runtime/wasmgc/promise/combinator-bodies.ts"];
function closure(reader: (path: string) => string): void {
  for (const path of paths) {
    const file = ts.createSourceFile(path, reader(path), ts.ScriptTarget.Latest, true);
    assert.equal((file as ts.SourceFile & { parseDiagnostics: unknown[] }).parseDiagnostics.length, 0);
    const edges: unknown[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        assert(
          ts.isStringLiteral(node.moduleSpecifier) &&
            clause &&
            !clause.name &&
            clause.namedBindings &&
            ts.isNamedImports(clause.namedBindings),
        );
        edges.push([
          node.moduleSpecifier.text,
          clause.isTypeOnly,
          clause.namedBindings.elements.map((element) => {
            assert(!element.propertyName && !element.isTypeOnly);
            return element.name.text;
          }),
        ]);
      }
      assert(!ts.isExportDeclaration(node) && !ts.isImportTypeNode(node) && !ts.isImportEqualsDeclaration(node));
      if (ts.isCallExpression(node)) {
        assert(node.expression.kind !== ts.SyntaxKind.ImportKeyword);
        assert(!(ts.isIdentifier(node.expression) && node.expression.text === "require"));
      }
      if (ts.isIdentifier(node))
        assert(
          !["CodegenContext", "FunctionContext", "TypeChecker", "SourceFile", "AsyncDriveRuntimeT"].includes(node.text),
        );
      ts.forEachChild(node, visit);
    };
    visit(file);
    assert.deepEqual(edges, [
      ["../../../wasm/model/instructions.js", true, ["FuncHandle", "Instr", "LocalDef", "TypeHandle", "ValType"]],
      [
        "./settlement-bodies.js",
        false,
        path.endsWith("delay-bodies.ts")
          ? ["PROMISE_STATE_PENDING"]
          : ["PROMISE_STATE_PENDING", "PROMISE_STATE_FULFILLED", "PROMISE_STATE_REJECTED"],
      ],
    ]);
  }
}
function walk(body: readonly Instr[]): Instr[] {
  return body.flatMap((instruction) => {
    const nested = instruction as Instr & {
      body?: Instr[];
      then?: Instr[];
      else?: Instr[];
      catchAll?: Instr[];
      catches?: { body: Instr[] }[];
    };
    return [
      instruction,
      ...[
        nested.body,
        nested.then,
        nested.else,
        nested.catchAll,
        ...(nested.catches ?? []).map((entry) => entry.body),
      ].flatMap((child) => (child ? walk(child) : [])),
    ];
  });
}
const capture = { captureTypeIdx: 31, promiseFieldIdx: 3, valueFieldIdx: 4 } as const;
const subscription: combinator.CombinatorSubscriptionResources = {
  elemCapsTypeIdx: 32,
  stateTypeIdx: 33,
  promiseTypeIdx: 34,
  callbackTypeIdx: 35,
  enqueueFuncIdx: 81,
  resolveValueFuncIdx: 82,
  markRejectionHandledFuncIdx: 83,
  bagInit: { op: "ref.null.extern" },
};
const resources: combinator.NativePromiseCombinatorVectorResources = {
  promiseTypeIdx: 34,
  stateTypeIdx: 33,
  arrTypeIdx: 36,
  vecTypeIdx: 37,
  argVecTypeIdx: 38,
  argArrTypeIdx: 39,
  subscribeFuncIdx: 81,
  fulfillReactionFuncIdx: 82,
  rejectReactionFuncIdx: 83,
  fulfillFuncIdx: 84,
  rejectFuncIdx: 85,
  bagInit: { op: "ref.null.extern" },
  emptyResult: { kind: "fulfill-vector" },
};
const locals: combinator.NativePromiseCombinatorVectorLocals = {
  argVecLocal: 9,
  resultLocal: 13,
  arrLocal: 14,
  stateLocal: 15,
  nLocal: 16,
  iLocal: 17,
};

describe("context-free delay/combinator executable ownership", () => {
  it("requires both exact canonical roots and their complete downward imports", () => closure(read));
  for (const missing of paths)
    it(`fails closed for missing ${missing}`, () => {
      expect(() =>
        closure((path) => {
          if (path === missing) throw new Error("missing owner");
          return read(path);
        }),
      ).toThrow();
    });
  for (const edge of [
    'import type { CodegenContext } from "../../../codegen/context/types.js";',
    'import { compile } from "../../../index.js";',
    'export * from "../../../codegen/promise-combinators.js";',
    'export type Hidden = import("../../../ir/types.js").Instr;',
    'void import("./missing.js");',
    "void import(target);",
    "void require(target);",
    'import hidden = require("./missing.js");',
    "export const broken = ;",
  ])
    it(`rejects forbidden edge ${edge}`, () => expect(() => closure((path) => read(path) + "\n" + edge)).toThrow());
  it("keeps callback root/capture fields, exact boxing then resolve-value, and no locals", () => {
    expect(delay.buildNativePromiseDelayCallbackLocals()).toEqual([]);
    expect(
      delay.buildNativePromiseDelayCallbackBody({ capture, boxNumberFuncIdx: 40, resolveValueFuncIdx: 41 }),
    ).toEqual([
      { op: "local.get", index: 0 },
      { op: "ref.cast", typeIdx: 31 },
      { op: "struct.get", typeIdx: 31, fieldIdx: 3 },
      { op: "local.get", index: 0 },
      { op: "ref.cast", typeIdx: 31 },
      { op: "struct.get", typeIdx: 31, fieldIdx: 4 },
      { op: "call", funcIdx: 40 },
      { op: "call", funcIdx: 41 },
      { op: "drop" },
    ]);
  });
  it("preserves delay allocation/capture operand order and both nonaliasing exception routes", () => {
    const body = delay.buildNativePromiseDelayProviderBody({
      promiseTypeIdx: 30,
      capture,
      timerCallbackFuncIdx: 40,
      timerFuncIdx: 41,
      boxNumberFuncIdx: 42,
      rejectFuncIdx: 43,
      exnTagIdx: 7,
      callbackArity: 0,
      bagInit: { op: "ref.null.extern" },
    });
    expect(delay.buildNativePromiseDelayProviderLocals(30)).toEqual([
      { name: "$promise", type: { kind: "ref", typeIdx: 30 } },
      { name: "$reason", type: { kind: "externref" } },
    ]);
    expect(body.slice(0, 6)).toEqual([
      { op: "i32.const", value: 0 },
      { op: "ref.null.extern" },
      { op: "ref.null.extern" },
      { op: "ref.null.extern" },
      { op: "struct.new", typeIdx: 30 },
      { op: "local.set", index: 2 },
    ]);
    const guarded = body[6];
    assert(guarded?.op === "try");
    expect(guarded.body).toEqual([
      { op: "ref.func", funcIdx: 40 },
      { op: "i32.const", value: 0 },
      { op: "ref.null.extern" },
      { op: "local.get", index: 2 },
      { op: "local.get", index: 1 },
      { op: "struct.new", typeIdx: 31 },
      { op: "extern.convert_any" },
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: 42 },
      { op: "call", funcIdx: 41 },
      { op: "drop" },
    ]);
    expect(guarded.catches).toEqual([
      {
        tagIdx: 7,
        body: [
          { op: "local.set", index: 3 },
          { op: "local.get", index: 2 },
          { op: "local.get", index: 3 },
          { op: "call", funcIdx: 43 },
          { op: "drop" },
        ],
      },
    ]);
    expect(guarded.catchAll).toEqual([
      { op: "local.get", index: 2 },
      { op: "ref.null.extern" },
      { op: "call", funcIdx: 43 },
      { op: "drop" },
    ]);
    expect(body.slice(7)).toEqual([{ op: "local.get", index: 2 }, { op: "extern.convert_any" }]);
    const tagged = new Set(walk(guarded.catches![0]!.body));
    expect(walk(guarded.catchAll!).some((value) => tagged.has(value))).toBe(false);
    expect(body[3]).not.toBe(guarded.body[2]);
  });
  for (const invalid of [undefined, -1, NaN])
    it(`rejects unresolved canonical resolve-value ${invalid}`, () => {
      expect(() => combinator.buildSubscribeBody({ ...subscription, resolveValueFuncIdx: invalid as number })).toThrow(
        "resolve-value",
      );
    });
  for (const mark of [undefined, 0, 83])
    it(`preserves zero resolve handle and optional handled binding ${mark}`, () => {
      const value = { ...subscription, resolveValueFuncIdx: 0, markRejectionHandledFuncIdx: mark };
      const body = combinator.buildSubscribeBody(value),
        prefix = body[3];
      assert(prefix?.op === "if");
      expect(combinator.buildSubscribeLocals(34)).toEqual([
        { name: "$p", type: { kind: "ref", typeIdx: 34 } },
        { name: "$caps", type: { kind: "externref" } },
      ]);
      expect(prefix.else).toEqual([
        { op: "i32.const", value: 0 },
        { op: "ref.null.extern" },
        { op: "ref.null.extern" },
        { op: "ref.null.extern" },
        { op: "struct.new", typeIdx: 34 },
        { op: "local.set", index: 5 },
        { op: "local.get", index: 5 },
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: 0 },
        { op: "drop" },
      ]);
      expect(body.slice(4)).toEqual(combinator.buildSubscribeDispatchBody(value));
      const calls = walk(body.slice(4)).filter((instruction) => instruction.op === "call");
      expect(calls).toEqual([
        ...(mark === undefined ? [] : [{ op: "call", funcIdx: mark }]),
        { op: "call", funcIdx: 81 },
        { op: "call", funcIdx: 81 },
      ]);
      expect(walk(body).filter((instruction) => instruction.op === "struct.set")).toEqual([
        { op: "struct.set", typeIdx: 34, fieldIdx: 2 },
      ]);
    });
  it("retains all-fulfill store/decrement order, original value, and shared wrapper settlement result", () => {
    const types = { elemCapsTypeIdx: 32, stateTypeIdx: 33 };
    expect(combinator.buildAllFulfillLocals(types)).toEqual([
      ...combinator.buildSettleWrapperLocals(types),
      { name: "$rem", type: { kind: "i32" } },
    ]);
    const body = combinator.buildAllFulfillBody({ ...types, arrTypeIdx: 36, vecTypeIdx: 37, fulfillFuncIdx: 84 });
    expect(body.slice(13, 20)).toEqual([
      { op: "local.get", index: 3 },
      { op: "local.get", index: 3 },
      { op: "struct.get", typeIdx: 33, fieldIdx: 3 },
      { op: "i32.const", value: 1 },
      { op: "i32.sub" },
      { op: "local.tee", index: 4 },
      { op: "struct.set", typeIdx: 33, fieldIdx: 3 },
    ]);
    expect(body.at(-1)).toEqual({ op: "local.get", index: 1 });
    for (const [build, index] of [
      [combinator.buildRaceFulfillBody, 84],
      [combinator.buildRejectBody, 85],
    ] as const) {
      const settled = build(types, index);
      expect(settled).toEqual(combinator.buildSettleResultBody(types, index));
      expect(settled.at(-1)).toEqual({ op: "call", funcIdx: index });
      expect(walk(settled).some((instruction) => instruction.op === "drop")).toBe(false);
    }
  });
  for (const emptyResult of [
    { kind: "fulfill-vector" },
    { kind: "pending" },
    { kind: "reject-aggregate", aggregateErrorFuncIdx: 86 },
  ] as const) {
    it(`builds nonzero-local detached vector loop: ${emptyResult.kind}`, () => {
      const rejection: Instr[] = [{ op: "ref.null.extern" }];
      const body = combinator.buildNativePromiseCombinatorVectorBody({ ...resources, emptyResult }, locals, {
        notIterLocal: 0,
        rejectReason: rejection,
      });
      expect(body.slice(0, 4)).toEqual([
        { op: "local.get", index: 9 },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: 38, fieldIdx: 0 },
        { op: "local.set", index: 16 },
      ]);
      expect(walk(body).some((instruction) => instruction.op === "array.len" || instruction.op === "return")).toBe(
        false,
      );
      expect(body.slice(17, 21)).toEqual([
        { op: "struct.new", typeIdx: 33 },
        { op: "local.set", index: 15 },
        { op: "local.get", index: 0 },
        expect.objectContaining({ op: "if" }),
      ]);
      const reject = body[20];
      assert(reject?.op === "if");
      expect(reject.then[1]).toBe(rejection[0]);
      const calls = walk(body)
        .filter((instruction) => instruction.op === "call")
        .map((instruction) => instruction.funcIdx);
      expect(calls).toEqual([
        85,
        ...(emptyResult.kind === "fulfill-vector" ? [84] : emptyResult.kind === "reject-aggregate" ? [86, 85] : []),
        81,
      ]);
      expect(walk(body).filter((instruction) => instruction.op === "ref.func")).toEqual([
        { op: "ref.func", funcIdx: 82 },
        { op: "ref.func", funcIdx: 83 },
      ]);
      expect(walk(body).filter((instruction) => instruction.op === "br" || instruction.op === "br_if")).toEqual([
        { op: "br_if", depth: 1 },
        { op: "br", depth: 0 },
      ]);
      expect(body.slice(-2)).toEqual([{ op: "local.get", index: 13 }, { op: "extern.convert_any" }]);
    });
  }
});

function context() {
  const source = analyzeSource("export function main(): number { return 1; }", "combinator-ownership.ts");
  return createCodegenContext(createEmptyModule(), source.checker, { standalone: true, nativeStrings: true });
}
function functionContext(): FunctionContext {
  return {
    name: "owned",
    params: [{ name: "arg", type: { kind: "externref" } }],
    locals: [{ name: "before", type: { kind: "i32" } }],
    localMap: new Map([
      ["arg", 0],
      ["before", 1],
    ]),
    returnType: { kind: "externref" },
    body: [{ op: "nop" }],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };
}
afterEach(() => vi.restoreAllMocks());
describe("real registration and detached-buffer adapter lifecycle", () => {
  it("keeps the public compiler root and same cached combinator/provider objects", () => {
    expect(compile).toBeTypeOf("function");
    const ctx = context(),
      ids = ensureCombinatorFunctions(ctx),
      count = ctx.mod.functions.length;
    expect(ensureCombinatorFunctions(ctx)).toBe(ids);
    expect(ctx.mod.functions).toHaveLength(count);
    expect(new Set([ids.subscribeFuncIdx, ids.allFulfillFuncIdx, ids.raceFulfillFuncIdx, ids.rejectFuncIdx]).size).toBe(
      4,
    );
    for (const [field, name] of [
      ["subscribeFuncIdx", "__combinator_subscribe"],
      ["allFulfillFuncIdx", "__combinator_all_fulfill"],
      ["raceFulfillFuncIdx", "__combinator_race_fulfill"],
      ["rejectFuncIdx", "__combinator_reject"],
    ] as const) {
      expect(definedFuncAt(ctx, ids[field])?.name).toBe(name);
      expect(ctx.funcMap.get(name)).toBe(ids[field]);
    }
    const index = ensureIrNativePromiseAllProvider(ctx),
      provider = definedFuncAt(ctx, index);
    expect(provider).toBeDefined();
    expect(ensureIrNativePromiseAllProvider(ctx)).toBe(index);
    expect(definedFuncAt(ctx, index)).toBe(provider);
  });
  it("publishes delay callback first, retains capture subtype/header and cached identity", () => {
    const ctx = context();
    // Production Promise-delay preflight requires this exact scheduling import
    // before invoking the adapter; the adapter owns the native dependencies.
    const externref = { kind: "externref" } as const;
    const timer = ensureLateImport(ctx, "__timer_set_timeout", [externref, externref], [externref], "env");
    assert(timer !== undefined);
    flushLateImportShifts(ctx, null);
    expect(ctx.funcMap.get("__timer_set_timeout")).toBe(timer);
    expect(funcSignatureOf(ctx, timer)).toMatchObject({ params: [externref, externref], results: [externref] });
    expect(
      ctx.mod.imports.filter(
        (entry) => entry.module === "env" && entry.name === "__timer_set_timeout" && entry.desc.kind === "func",
      ),
    ).toHaveLength(1);
    const index = ensureIrNativePromiseDelayProvider(ctx),
      provider = definedFuncAt(ctx, index);
    for (const name of ["__box_number", "__promise_resolve_value"] as const) {
      const handle = ctx.funcMap.get(name);
      assert(handle !== undefined);
      expect(definedFuncAt(ctx, handle)?.name).toBe(name);
    }
    const callback = ctx.mod.functions.find((value) => value.name === "__ir_promise_delay_timer_callback");
    assert(provider && callback);
    expect(ctx.mod.functions.indexOf(callback)).toBeLessThan(ctx.mod.functions.indexOf(provider));
    expect(ensureIrNativePromiseDelayProvider(ctx)).toBe(index);
    expect(definedFuncAt(ctx, index)).toBe(provider);
    const captureType = ctx.mod.types.find(
      (value) => value.kind === "struct" && value.name === "$__ir_promise_delay_timer_cap",
    );
    assert(captureType?.kind === "struct");
    expect(captureType.superTypeIdx).toBeDefined();
    expect(captureType.fields.map((field) => field.name)).toEqual(["func", "$arity", "$bag", "promise", "value"]);
    expect(ctx.requiresStandaloneTimerCallbackDispatch).toBe(true);
  });
  it("keeps the legacy missing-resolver prefix exclusively in the compatibility adapter", () => {
    const ctx = context();
    const lookup = ctx.funcMap.get.bind(ctx.funcMap);
    vi.spyOn(ctx.funcMap, "get").mockImplementation((name) =>
      name === "__promise_resolve_value" ? undefined : lookup(name),
    );
    const spy = vi.spyOn(combinator, "buildSubscribeDispatchBody"),
      canonical = vi.spyOn(combinator, "buildSubscribeBody");
    const ids = ensureCombinatorFunctions(ctx),
      functionBody = definedFuncAt(ctx, ids.subscribeFuncIdx)!.body;
    const arm = functionBody[3];
    assert(arm?.op === "if");
    expect(arm.else?.[0]).toEqual({ op: "i32.const", value: 1 });
    expect(spy).toHaveBeenCalled();
    expect(canonical).not.toHaveBeenCalled();
  });
  for (const method of ["all", "race", "allSettled", "any"] as const)
    it(`immediately appends after ${method} registration without replacing owned buffers`, () => {
      const ctx = context(),
        ids = ensureCombinatorFunctions(ctx),
        fctx = functionContext();
      ctx.currentFunc = fctx;
      const before = {
        body: fctx.body,
        locals: fctx.locals,
        localMap: fctx.localMap,
        savedBodies: fctx.savedBodies,
        liveBodies: ctx.liveBodies,
      };
      const spy = vi.spyOn(combinator, "buildNativePromiseCombinatorVectorBody");
      emitStandalonePromiseCombinatorRuntime(ctx, fctx, method, 0, ids.vecTypeIdx, ids.arrTypeIdx);
      expect(spy).toHaveBeenCalledTimes(1);
      const [projection, allocation] = spy.mock.calls[0]!;
      const emitted = spy.mock.results[0]!.value as Instr[];
      expect(projection.subscribeFuncIdx).toBe(ids.subscribeFuncIdx);
      expect(allocation).toEqual({ argVecLocal: 0, resultLocal: 2, arrLocal: 3, stateLocal: 4, nLocal: 5, iLocal: 6 });
      expect(fctx.locals.slice(1).map((local) => local.name)).toEqual([
        "__comb_result_1",
        "__comb_arr_2",
        "__comb_state_3",
        "__comb_n_4",
        "__comb_i_5",
      ]);
      expect(fctx.body.slice(1)).toEqual(emitted);
      emitted.forEach((instruction, index) => expect(fctx.body[index + 1]).toBe(instruction));
      for (const key of ["body", "locals", "localMap", "savedBodies"] as const) expect(fctx[key]).toBe(before[key]);
      expect(ctx.liveBodies).toBe(before.liveBodies);
      const handles = walk(emitted)
        .filter((instruction) => instruction.op === "call" || instruction.op === "ref.func")
        .map((instruction) => instruction.funcIdx);
      shiftLateImportIndices(ctx, fctx, 0, 1);
      expect(
        walk(emitted)
          .filter((instruction) => instruction.op === "call" || instruction.op === "ref.func")
          .map((instruction) => instruction.funcIdx),
      ).toEqual(handles);
    });
  it("retains all eight mutable side-channel fields and the negative/zero shift rules", () => {
    const ctx = context(),
      ids = ensureCombinatorFunctions(ctx);
    const keys = [
      "subscribeFuncIdx",
      "allFulfillFuncIdx",
      "raceFulfillFuncIdx",
      "rejectFuncIdx",
      "allSettledFulfillFuncIdx",
      "allSettledRejectFuncIdx",
      "anyRejectFuncIdx",
      "aggErrNewFuncIdx",
    ] as const;
    keys.forEach((key, index) => {
      ids[key] = 40 + index;
    });
    shiftAsyncSideChannelFuncIdxs(ctx, 0, 2);
    keys.forEach((key, index) => expect(ids[key]).toBe(42 + index));
    ids.subscribeFuncIdx = -1;
    ids.rejectFuncIdx = 0;
    shiftAsyncSideChannelFuncIdxs(ctx, 0, 3);
    expect(ids.subscribeFuncIdx).toBe(-1);
    expect(ids.rejectFuncIdx).toBe(3);
    const before = { ...ids };
    shiftAsyncSideChannelFuncIdxs(ctx, 0, 0);
    expect(ids).toEqual(before);
  });
  it("restores exact currentFunc and exact sentinel without minting a provider after failed body construction", () => {
    const ctx = context(),
      previous = functionContext();
    ensureCombinatorFunctions(ctx);
    ctx.currentFunc = previous;
    const sentinel = new Error("sentinel body construction"),
      count = ctx.mod.functions.length;
    vi.spyOn(combinator, "buildNativePromiseCombinatorVectorBody").mockImplementation(() => {
      throw sentinel;
    });
    let thrown: unknown;
    try {
      ensureIrNativePromiseAllProvider(ctx);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(sentinel);
    expect(ctx.currentFunc).toBe(previous);
    expect(ctx.mod.functions).toHaveLength(count);
    expect(ctx.mod.functions.some((value) => value.name.includes("__ir_async_promise_all"))).toBe(false);
  });
});
