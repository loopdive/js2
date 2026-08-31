// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Resolved identifier writes and their module-lexical TDZ guard. */
import { ts } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { allocLocal, getLocalType } from "../context/locals.js";
import { localGlobalIdx } from "../registry/imports.js";
import { coerceType, compileExpression, valTypesMatch } from "../shared.js";
import { emitTdzCheckAtGlobal } from "../statements/tdz.js";
import { emitThrowTypeError, isConstIdentifierAssignmentTarget } from "./helpers.js";
import {
  analyzeTdzAccess as analyzeIdentifierTdzAccess,
  emitLocalTdzCheck,
  emitStaticTdzThrow,
} from "./identifiers.js";
import { currentSourceModuleGlobalIndex, moduleTdzGlobalIndexForIdentifier } from "./identifier-module-storage.js";

/**
 * Emit the TDZ half of an identifier PutValue after its source value has been
 * acquired. Returns true only when static analysis emitted an abrupt throw.
 */
export function emitIdentifierAssignmentTdzGuard(
  ctx: CodegenContext,
  fctx: FunctionContext,
  id: ts.Identifier,
  pendingStackValue = false,
): boolean {
  const localFlag = fctx.tdzFlagLocals?.get(id.text);
  const moduleFlagIdx = moduleTdzGlobalIndexForIdentifier(ctx, id);
  if (localFlag === undefined && moduleFlagIdx === undefined) return false;
  const decision = analyzeIdentifierTdzAccess(ctx, id);
  if (decision === "throw") {
    if (pendingStackValue) fctx.body.push({ op: "drop" });
    emitStaticTdzThrow(ctx, fctx, id.text);
    return true;
  }
  if (decision !== "check") return false;
  if (localFlag !== undefined) {
    emitLocalTdzCheck(ctx, fctx, id.text, localFlag);
    return false;
  }
  // PutValue errors are observable to JS catch/instanceof, even on the host
  // lane. A bare Wasm tag would skip the later real-error guard and surface as
  // the wrong error class.
  if (moduleFlagIdx !== undefined) emitTdzCheckAtGlobal(ctx, fctx, moduleFlagIdx, id.text, true);
  return false;
}

/** Evaluate a simple-assignment RHS before an abrupt lexical PutValue. */
export function tryConstSet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  id: ts.Identifier,
  right: ts.Expression,
): boolean {
  const isConst = isConstIdentifierAssignmentTarget(ctx, fctx, id);
  const hasTdzFlag =
    fctx.tdzFlagLocals?.has(id.text) === true || moduleTdzGlobalIndexForIdentifier(ctx, id) !== undefined;
  // A simple assignment evaluates its RHS before PutValue. This early arm is
  // only for a statically future lexical whose storage falls through a
  // same-named foreign module-global projection before the normal write arm.
  if (!isConst && !(hasTdzFlag && analyzeIdentifierTdzAccess(ctx, id) === "throw")) return false;
  const rhsType = compileExpression(ctx, fctx, right);
  if (rhsType) fctx.body.push({ op: "drop" });
  if (!emitIdentifierAssignmentTdzGuard(ctx, fctx, id) && isConst) {
    emitThrowTypeError(ctx, fctx, "Assignment to constant variable.");
    fctx.body.push({ op: "unreachable" });
  }
  return isConst || hasTdzFlag;
}

/**
 * Guard an exact const target before callers evaluate a compound RHS or begin
 * an update read. Callers receive `"not-const"` for every other identifier.
 * A statically future lexical must throw ReferenceError first; an
 * initialized const keeps the caller's ordinary TypeError ordering.
 */
function constIdentifierAssignmentTdzState(
  ctx: CodegenContext,
  fctx: FunctionContext,
  id: ts.Identifier,
): "not-const" | "tdz-throw" | "const" {
  if (!isConstIdentifierAssignmentTarget(ctx, fctx, id)) return "not-const";
  return emitIdentifierAssignmentTdzGuard(ctx, fctx, id) ? "tdz-throw" : "const";
}

/**
 * Handle a const identifier compound target before its caller evaluates an
 * ordinary read-modify-write path. Returns true exactly when it emitted the
 * abrupt completion (including the TDZ-before-RHS case).
 */
export function tryEmitConstIdentifierCompoundAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  id: ts.Identifier,
  right: ts.Expression,
): boolean {
  const target = constIdentifierAssignmentTdzState(ctx, fctx, id);
  if (target === "not-const") return false;
  if (target === "const") {
    const rhsType = compileExpression(ctx, fctx, right);
    if (rhsType) fctx.body.push({ op: "drop" });
    emitThrowTypeError(ctx, fctx, "Assignment to constant variable.");
    fctx.body.push({ op: "unreachable" });
  }
  return true;
}

/** Handle a const identifier prefix/postfix update before the value is read. */
export function emitConstIdentifierUpdateGuard(ctx: CodegenContext, fctx: FunctionContext, id: ts.Identifier): boolean {
  const target = constIdentifierAssignmentTdzState(ctx, fctx, id);
  if (target === "not-const") return false;
  if (target === "const") {
    emitThrowTypeError(ctx, fctx, "Assignment to constant variable.");
    fctx.body.push({ op: "unreachable" });
  }
  return true;
}

/**
 * (#5146 cluster C) §6.2.5.6 PutValue guards every identifier assignment target
 * must observe, including the ones reached through a destructuring pattern:
 * a write to a lexical binding still in its TDZ is a ReferenceError, and a write
 * to a `const` binding is a TypeError. The TDZ check must precede the const
 * check — an uninitialised `const` is a ReferenceError, not a TypeError.
 * Consumes the pending stack value when it takes over (returns true).
 */
export function emitPutValueTargetGuard(
  ctx: CodegenContext,
  fctx: FunctionContext,
  id: ts.Identifier,
  pendingStackValue = true,
): boolean {
  if (emitIdentifierAssignmentTdzGuard(ctx, fctx, id, pendingStackValue)) return true;
  if (!isConstIdentifierAssignmentTarget(ctx, fctx, id)) return false;
  if (pendingStackValue) fctx.body.push({ op: "drop" });
  emitThrowTypeError(ctx, fctx, "Assignment to constant variable.");
  fctx.body.push({ op: "unreachable" });
  return true;
}

/** Resolve a pattern-write identifier to durable module storage when it has it. */
export function resolveModuleAwareIdentifierWriteTarget(
  ctx: CodegenContext,
  fctx: FunctionContext,
  id: ts.Identifier,
  valueType: ValType,
): { localIdx: number | undefined; moduleGlobalIdx: number | undefined } {
  // A physical module-init leaf cannot retain a source binding in a Wasm
  // local. Prefer its durable source-qualified global, while ordinary
  // functions and the unsplit initializer retain their established local
  // shadow behavior.
  const durableModuleGlobalIdx = fctx.moduleInitChunk ? currentSourceModuleGlobalIndex(ctx, id) : undefined;
  let localIdx = durableModuleGlobalIdx === undefined ? fctx.localMap.get(id.text) : undefined;
  const moduleGlobalIdx =
    durableModuleGlobalIdx ?? (localIdx === undefined ? currentSourceModuleGlobalIndex(ctx, id) : undefined);
  if (localIdx === undefined && moduleGlobalIdx === undefined) localIdx = allocLocal(fctx, id.text, valueType);
  return { localIdx, moduleGlobalIdx };
}

/** Complete a plain for-of head's PutValue, using durable storage in chunks. */
export function tryEmitForOfIdentifierWrite(
  ctx: CodegenContext,
  fctx: FunctionContext,
  id: ts.Identifier,
  valueLocal: number,
  valueType: ValType,
): boolean {
  if (emitPutValueTargetGuard(ctx, fctx, id, false)) return true;
  if (!fctx.moduleInitChunk) return false;
  const moduleGlobalIdx = currentSourceModuleGlobalIndex(ctx, id);
  if (moduleGlobalIdx === undefined) return false;
  fctx.body.push({ op: "local.get", index: valueLocal });
  emitResolvedIdentifierWriteFromStack(ctx, fctx, id, valueType, undefined, moduleGlobalIdx);
  return true;
}

/** Consume one precomputed stack value through an already-resolved target. */
export function emitResolvedIdentifierWriteFromStack(
  ctx: CodegenContext,
  fctx: FunctionContext,
  id: ts.Identifier,
  valueType: ValType,
  localIdx: number | undefined,
  moduleGlobalIdx: number | undefined,
  allowUnresolvedTopLevelVariable = false,
): boolean {
  // A provider or string constant settled while evaluating the value may have
  // inserted an import global. Treat the caller's index as target identity
  // only; re-read the graph-global name map before inspecting its type.
  if (emitPutValueTargetGuard(ctx, fctx, id)) return true;
  const durableModuleGlobalIdx = fctx.moduleInitChunk
    ? currentSourceModuleGlobalIndex(ctx, id, allowUnresolvedTopLevelVariable)
    : undefined;
  const currentModuleGlobalIdx =
    durableModuleGlobalIdx ??
    (moduleGlobalIdx === undefined
      ? undefined
      : (currentSourceModuleGlobalIndex(ctx, id, allowUnresolvedTopLevelVariable) ?? moduleGlobalIdx));
  const currentLocalIdx = durableModuleGlobalIdx === undefined ? localIdx : undefined;
  const targetType =
    currentLocalIdx !== undefined
      ? getLocalType(fctx, currentLocalIdx)
      : currentModuleGlobalIdx !== undefined
        ? ctx.mod.globals[localGlobalIdx(ctx, currentModuleGlobalIdx)]?.type
        : undefined;
  if (currentLocalIdx === undefined && currentModuleGlobalIdx === undefined) return false;
  if (targetType && !valTypesMatch(valueType, targetType)) coerceType(ctx, fctx, valueType, targetType);
  if (currentLocalIdx !== undefined) {
    fctx.body.push({ op: "local.set", index: currentLocalIdx });
    return true;
  }
  // A closure-backed top-level binding keeps an externref shadow local for
  // precise same-helper reads. Chunk leaves must still persist the write in
  // the module global for subsequent helpers, so mirror the already-coerced
  // value into that established shadow before the durable store.
  const shadowLocalIdx =
    durableModuleGlobalIdx === undefined ? undefined : fctx.moduleBindingShadowLocals?.get(id.text);
  if (shadowLocalIdx !== undefined) fctx.body.push({ op: "local.tee", index: shadowLocalIdx });
  // Re-read after coercion/guard helpers: either can settle imports/globals.
  fctx.body.push({ op: "global.set", index: ctx.moduleGlobals.get(id.text)! });
  return true;
}
