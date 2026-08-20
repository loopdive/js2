// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { IR_ASYNC_PROMISE_ALL_NATIVE_FN } from "../ir/async-semantic-runtime.js";
import type { WasmFunction } from "../ir/types.js";
import { ensureCombinatorFunctions, emitStandalonePromiseCombinatorRuntime } from "./promise-combinators.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { definedFuncAt, funcSignatureOf, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";

interface NativeAsyncRuntimeState {
  readonly promiseAllFuncIdx?: number;
  readonly promiseAllVecTypeIdx?: number;
}

type NativeAsyncRuntimeContext = CodegenContext & {
  __irNativeAsyncRuntime?: NativeAsyncRuntimeState;
};

function requireUnoccupied(ctx: CodegenContext, name: string): void {
  if (
    ctx.funcMap.has(name) ||
    ctx.mod.functions.some((fn) => fn.name === name) ||
    ctx.mod.imports.some((entry) => entry.desc.kind === "func" && entry.name === name)
  ) {
    throw new Error(`standalone IR async provider name ${name} is already occupied`);
  }
}

function exactDefinedFunction(ctx: CodegenContext, index: number, name: string): WasmFunction {
  const fn = definedFuncAt(ctx, index);
  if (!fn || fn.name !== name || ctx.funcMap.get(name) !== index) {
    throw new Error(`standalone IR async provider ${name} lost its exact function handle`);
  }
  return fn;
}

function assertPromiseAllAbi(ctx: CodegenContext, index: number, vecTypeIdx: number): void {
  const signature = funcSignatureOf(ctx, index);
  if (
    signature?.params.length !== 1 ||
    signature.params[0]?.kind !== "ref_null" ||
    signature.params[0].typeIdx !== vecTypeIdx ||
    signature.results.length !== 1 ||
    signature.results[0]?.kind !== "externref"
  ) {
    throw new Error("standalone IR Promise.all provider has a malformed ABI");
  }
}

function remember(ctx: CodegenContext, update: Partial<NativeAsyncRuntimeState>): NativeAsyncRuntimeState {
  const current = (ctx as NativeAsyncRuntimeContext).__irNativeAsyncRuntime ?? {};
  const next = Object.freeze({ ...current, ...update });
  (ctx as NativeAsyncRuntimeContext).__irNativeAsyncRuntime = next;
  return next;
}

/** Register `(ref null $vec_externref) -> externref<$Promise>` over the shared native combinator. */
export function ensureIrNativePromiseAllProvider(ctx: CodegenContext): number {
  const state = (ctx as NativeAsyncRuntimeContext).__irNativeAsyncRuntime;
  const cached = state?.promiseAllFuncIdx;
  if (cached !== undefined) {
    if (!state || state.promiseAllVecTypeIdx === undefined) {
      throw new Error("standalone IR Promise.all provider lost its canonical pending-vector type");
    }
    exactDefinedFunction(ctx, cached, IR_ASYNC_PROMISE_ALL_NATIVE_FN);
    assertPromiseAllAbi(ctx, cached, state.promiseAllVecTypeIdx);
    return cached;
  }
  if (!ctx.standalone || ctx.wasi || !ctx.nativeStrings) {
    throw new Error("native IR Promise.all provider requires standalone WasmGC with native strings");
  }
  requireUnoccupied(ctx, IR_ASYNC_PROMISE_ALL_NATIVE_FN);

  // The shared runtime owns the canonical externref vector and all reaction
  // functions. Complete those registrations before the provider handle/body
  // bake any indices.
  const combinator = ensureCombinatorFunctions(ctx);
  const pendingType = { kind: "ref_null", typeIdx: combinator.vecTypeIdx } as const;
  const typeIdx = addFuncType(ctx, [pendingType], [{ kind: "externref" }]);
  const fctx: FunctionContext = {
    name: IR_ASYNC_PROMISE_ALL_NATIVE_FN,
    params: [{ name: "pending", type: pendingType }],
    locals: [],
    localMap: new Map([["pending", 0]]),
    returnType: { kind: "externref" },
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };
  const previous = ctx.currentFunc;
  ctx.currentFunc = fctx;
  try {
    emitStandalonePromiseCombinatorRuntime(ctx, fctx, "all", 0, combinator.vecTypeIdx, combinator.arrTypeIdx);
    fctx.body.push({ op: "return" });
  } finally {
    ctx.currentFunc = previous;
  }

  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: IR_ASYNC_PROMISE_ALL_NATIVE_FN,
    typeIdx,
    locals: fctx.locals,
    body: fctx.body,
    exported: false,
  });
  ctx.funcMap.set(IR_ASYNC_PROMISE_ALL_NATIVE_FN, funcIdx);
  remember(ctx, { promiseAllFuncIdx: funcIdx, promiseAllVecTypeIdx: combinator.vecTypeIdx });
  exactDefinedFunction(ctx, funcIdx, IR_ASYNC_PROMISE_ALL_NATIVE_FN);
  assertPromiseAllAbi(ctx, funcIdx, combinator.vecTypeIdx);
  return funcIdx;
}
