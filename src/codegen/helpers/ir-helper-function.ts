// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#7106) The one home for a compiler-built helper function: a fresh
 * `FunctionContext` over fixed parameters, and its publication as a defined
 * function under its name. Every IR wrapper codegen builds from legacy's own
 * emitters (`dyn.construct`, `dyn.instanceof`, `dyn.delete`, the realm global
 * object, the per-function `instanceof` test) goes through these two, so the
 * `FunctionContext` literal and the addFuncType / mint / funcMap / push
 * sequence are written once.
 */
import type { ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { addFuncType } from "../registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "../func-space.js";

/** A fresh helper `FunctionContext` whose parameters are addressable by name. */
export function helperFunctionContext(
  name: string,
  params: { name: string; type: ValType }[],
  returnType: ValType | null,
): FunctionContext {
  return {
    name,
    params,
    locals: [],
    localMap: new Map(params.map((param, index) => [param.name, index])),
    returnType,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };
}

/**
 * Register the finished helper as a defined function under its name; its one
 * result is its declared return type (none for void). Returns the function index.
 */
export function publishHelperFunction(ctx: CodegenContext, helper: FunctionContext): number {
  const typeIdx = addFuncType(
    ctx,
    helper.params.map((param) => param.type),
    helper.returnType === null ? [] : [helper.returnType],
  );
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(helper.name, funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: helper.name,
    typeIdx,
    locals: helper.locals,
    body: helper.body,
    exported: false,
  });
  return funcIdx;
}
