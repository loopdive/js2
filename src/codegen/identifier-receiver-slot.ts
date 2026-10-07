// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// identifier-receiver-slot.ts — does an identifier receiver's STORAGE SLOT hold
// an externref, whatever its checker type says?
//
// `finalizeStructAndDynamicMemberGet` admits a member read to the dynamic
// `__extern_get` lane when the receiver is physically an externref. The
// checker's flow type is not a reliable witness for that: a binding written
// only inside a nested function (`let inst; … componentDidMount() { inst =
// this }`, `catch (e) { caught = e }`) keeps the flow type `undefined`, whose
// wasm type is numeric, and the read used to fall through to the terminal
// constant `ref.null.extern`. The slot's representation is the honest source of
// truth about the runtime value, so this module answers from the slot.

import ts from "typescript";

import type { CodegenContext, FunctionContext } from "./context/types.js";
import { localGlobalIdx } from "./registry/imports.js";

/**
 * True when `name` resolves, in `fctx`, to a function-local slot carrying an
 * externref value:
 *
 * - a ref-cell-boxed binding (captured mutably by a closure, or an async-frame
 *   spill restored as its cell, #4618) — the cell's VALUE type is the
 *   representation; the local itself is the cell ref;
 * - otherwise the local/param slot's own type.
 */
export function identifierLocalSlotIsExternref(fctx: FunctionContext, name: string): boolean {
  const boxed = fctx.boxedCaptures?.get(name);
  if (boxed !== undefined) return boxed.valType.kind === "externref";
  const localIdx = fctx.localMap.get(name);
  if (localIdx === undefined) return false;
  const localType =
    localIdx < fctx.params.length ? fctx.params[localIdx]!.type : fctx.locals[localIdx - fctx.params.length]?.type;
  return localType?.kind === "externref";
}

/**
 * (#5195 Step 3.2, #4618) The same rule one scope up, and ONLY for a receiver
 * whose static type is purely `undefined`/`void` (every resolvable receiver
 * keeps its existing struct/fast lane byte-for-byte): a binding with no
 * function-local slot whose global is externref. The identifier read resolves
 * `capturedGlobals` (a function local promoted for a class method or callback)
 * before `moduleGlobals`, so this consults them in that order.
 */
export function undefinedTypedIdentifierGlobalIsExternref(
  ctx: CodegenContext,
  fctx: FunctionContext,
  id: ts.Identifier,
  objType: ts.Type,
): boolean {
  if ((objType.flags & ~(ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0) return false;
  if (fctx.localMap.get(id.text) !== undefined) return false;
  const globalIdx = ctx.capturedGlobals.get(id.text) ?? ctx.moduleGlobals.get(id.text);
  if (globalIdx === undefined) return false;
  return ctx.mod.globals[localGlobalIdx(ctx, globalIdx)]?.type.kind === "externref";
}

/**
 * (#4618) `const inst = instance` where `instance` is a mutable `let`/`var`
 * written only inside a nested function (`componentDidMount() { instance =
 * this }`). Flow analysis cannot see that write, so both bindings are typed
 * purely `undefined` and the copy resolved to the numeric undefined slot,
 * truncating the live object. An externref slot holds the real value and still
 * compares `=== undefined` when the source really is undefined.
 */
export function copiesUnseenWriteBinding(
  ctx: CodegenContext,
  decl: ts.VariableDeclaration,
  init: ts.Expression,
): boolean {
  if (!ts.isIdentifier(init)) return false;
  const kind = ctx.oracle.typeFactOf(decl.name).kind;
  if (kind !== "undefined" && kind !== "void") return false;
  const source = ctx.oracle.variableDeclarationOf(init);
  return source !== undefined && (ts.getCombinedNodeFlags(source) & ts.NodeFlags.Const) === 0;
}
