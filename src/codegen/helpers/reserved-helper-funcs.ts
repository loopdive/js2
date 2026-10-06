// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 TA1, #6771) Helper-function reservation primitives shared by the
 * `toLocaleString` element steps (`to-locale-string-element.ts` and
 * `expressions/bool-to-locale-string.ts`). Moved here unchanged so the Boolean
 * twin does not import the core module that calls it (#6797 import-cycle ratchet).
 */
import type { ValType, WasmFunction } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "../func-space.js";
import { addFuncType } from "../registry/types.js";

/** §7.1.17 ToString, the native every arm of every element tail ends in. */
export const TO_STRING = "__extern_toString";

/**
 * Mint a `(param) -> externref` placeholder whose body is a bare `unreachable`.
 * Both fills ALWAYS write a valid body, so this is a construction placeholder
 * and never a reachable trap.
 */
export function reservePlaceholder(ctx: CodegenContext, name: string, params: ValType[], typeName: string): number {
  const typeIdx = addFuncType(ctx, params, [{ kind: "externref" }], typeName);
  const funcIdx = mintDefinedFunc(ctx);
  const placeholder: WasmFunction = {
    name,
    typeIdx,
    locals: [],
    body: [{ op: "unreachable" }],
    exported: false,
  };
  pushDefinedFunc(ctx, funcIdx, placeholder);
  ctx.funcMap.set(name, funcIdx);
  return funcIdx;
}

/** A minimal FunctionContext: these bodies are BUILT, never compiled. */
export function makeHelperFctx(name: string, paramName: string, paramType: ValType): FunctionContext {
  return {
    name,
    params: [{ name: paramName, type: paramType }],
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

/** The reserved function record, or `undefined` when it is not there to fill. */
export function reservedFunc(ctx: CodegenContext, name: string): WasmFunction | undefined {
  const funcIdx = ctx.funcMap.get(name);
  if (funcIdx === undefined) return undefined;
  return definedFuncAt(ctx, funcIdx) ?? undefined;
}
