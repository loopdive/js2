// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6699) The first-class callable ABI of a function DECLARATION's value.
//
// A named function declaration has two signatures:
//
//  - its LIFTED Wasm signature (`getFuncSignature` on its `funcMap` slot):
//    `[valueCaptures..., tdzFlagBoxes..., (TS pseudo-this)?, userParams...]`;
//  - the signature of its VALUE (the closure struct `emitFuncRefAsClosure`
//    builds when the name is read as an expression): only `userParams`, with a
//    native-generator result bridged per `nativeGeneratorFunctionValueWrapperResults`.
//
// The value's closure struct is a subtype of the funcref wrapper keyed on the
// VALUE signature. Any consumer that recovers the wrapper for such a value
// from its name — e.g. the standalone dynamic array-callback path
// (`resolveDynamicCallbackClosure`, #3015/#4638) — must key on the same
// signature, or it casts to an unrelated wrapper and emits a `call_ref` whose
// func type expects the capture slots too. Measured on axios's
// `AxiosHeaders.prototype.delete`: `header.forEach(deleteHeader)` (the nested
// `deleteHeader` captures `self`, `matcher`, `deleted`) emitted a 6-param
// `call_ref` fed 3 arguments — invalid Wasm ("not enough arguments on the
// stack for call_ref (need 7, got 4)").

import type { CodegenContext } from "../context/types.js";
import type { ValType } from "../../ir/types.js";
import { ts } from "../../ts-api.js";
import { nativeGeneratorFunctionValueWrapperResults } from "../generators-factory-prototype.js";
import { sourceFunctionDeclarationForHandle } from "../program-abi-source-callable-planning.js";
import { getFuncSignature } from "./funcref-wrapper-types.js";

/** Whether a function declaration's first parameter is TypeScript's pseudo-`this`. */
export function hasExplicitThisParameter(declaration: ts.Node | undefined): declaration is ts.FunctionDeclaration {
  if (!declaration || !ts.isFunctionDeclaration(declaration)) return false;
  const first = declaration.parameters[0];
  return first !== undefined && ts.isIdentifier(first.name) && first.name.text === "this";
}

/**
 * The signature `emitFuncRefAsClosure(ctx, fctx, funcName, funcIdx)` registers
 * its closure wrapper under: the lifted signature with the leading capture and
 * TDZ-flag slots (and the TS pseudo-`this`) removed, results bridged for native
 * generators. `undefined` when `funcIdx` has no signature.
 */
export function funcValueCallableSignature(
  ctx: CodegenContext,
  funcName: string,
  funcIdx: number,
): { params: ValType[]; results: ValType[] } | undefined {
  const sig = getFuncSignature(ctx, funcIdx);
  if (!sig) return undefined;
  const captures = ctx.nestedFuncCaptures.get(funcName) ?? [];
  const leadingSlots = captures.length + captures.filter((cap) => cap.hasTdzFlag).length;
  const sourceUserParams = sig.params.slice(leadingSlots);
  const explicitThis = hasExplicitThisParameter(sourceFunctionDeclarationForHandle(ctx, funcIdx));
  return {
    params: (explicitThis ? sourceUserParams.slice(1) : sourceUserParams).map((param) => ({ ...param })),
    results: nativeGeneratorFunctionValueWrapperResults(ctx, sig.results),
  };
}
