// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Shared lowering for the computed portion of a member Reference used by
 * read-modify-write expressions (`base[key] op= rhs`, `base[key]++`, etc.).
 */
import { ts } from "../../ts-api.js";
import type { Instr, ValType } from "../../ir/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "../func-space.js";
import { addFuncType } from "../registry/types.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { ensureObjectRuntime } from "../object-runtime.js";
import { compileExpression } from "../shared.js";
import { emitThrowTypeError } from "./helpers.js";
import { ensureLateImport, flushLateImportShifts } from "./late-imports.js";

/**
 * (#2666) ToPropertyKey §7.1.19, applied exactly once to the key externref on
 * the stack. The resulting primitive string or preserved Symbol is safe to
 * reuse for both the read and the write.
 */
export function emitToPropertyKeyOnce(ctx: CodegenContext, fctx: FunctionContext): void {
  if (ctx.standalone) {
    ensureObjectRuntime(ctx);
    flushLateImportShifts(ctx, fctx);
    const tpkIdx = ctx.funcMap.get("__to_property_key");
    if (tpkIdx !== undefined) fctx.body.push({ op: "call", funcIdx: tpkIdx });
    return;
  }
  const tpkIdx = ensureLateImport(ctx, "__to_property_key", [{ kind: "externref" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  if (tpkIdx !== undefined) fctx.body.push({ op: "call", funcIdx: tpkIdx });
}

/** (#6963) `(externref obj, externref key) -> externref` element-store key canonicaliser. */
const ELEM_STORE_KEY = "__elem_store_key";

/**
 * (#6963) ToPropertyKey for the key of an element STORE whose receiver is in
 * `objLocal` (key externref on the stack, canonical key left on the stack).
 *
 * Standalone routes through `__elem_store_key`, reserved here with the plain
 * `__to_property_key(key)` body. `fillExternSetVecArms` (finalize, once every
 * array carrier exists) prepends one arm: a non-negative i31 key on a JS-array
 * carrier is returned UNCHANGED, so `__extern_set` reaches its numeric vec arm
 * instead of stringifying the index and re-parsing it. ToPropertyKey of a
 * Number has no observable side effects, so skipping it for that one shape
 * preserves the §13.15.2 evaluation order; every other receiver/key keeps the
 * string canonicalisation the receiver-specific setter arms rely on.
 */
export function emitElementStoreKeyOnce(ctx: CodegenContext, fctx: FunctionContext, objLocal: number): void {
  if (!ctx.standalone) {
    emitToPropertyKeyOnce(ctx, fctx);
    return;
  }
  ensureObjectRuntime(ctx);
  flushLateImportShifts(ctx, fctx);
  let helperIdx = ctx.funcMap.get(ELEM_STORE_KEY);
  if (helperIdx === undefined) {
    const tpkIdx = ctx.funcMap.get("__to_property_key");
    if (tpkIdx === undefined) {
      emitToPropertyKeyOnce(ctx, fctx);
      return;
    }
    const externref: ValType = { kind: "externref" };
    const typeIdx = addFuncType(ctx, [externref, externref], [externref], `$${ELEM_STORE_KEY}_type`);
    helperIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, helperIdx, {
      name: ELEM_STORE_KEY,
      typeIdx,
      locals: [],
      body: [
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: tpkIdx },
      ],
      exported: false,
    });
    ctx.funcMap.set(ELEM_STORE_KEY, helperIdx);
  }
  const keyTmp = allocLocal(fctx, `__elem_key_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: keyTmp });
  fctx.body.push({ op: "local.get", index: objLocal });
  fctx.body.push({ op: "local.get", index: keyTmp });
  fctx.body.push({ op: "call", funcIdx: helperIdx });
}

/**
 * §13.3.3 / §13.15.2 — after the raw key expression is evaluated, GetValue of
 * the member Reference rejects a nullish base before ToPropertyKey observes
 * the key value.
 */
function emitBaseCoercibilityGuard(ctx: CodegenContext, fctx: FunctionContext, baseLocal: number): void {
  const emitTypeErrorBranch = (): Instr[] => {
    const start = fctx.body.length;
    emitThrowTypeError(ctx, fctx, "Cannot read properties of null or undefined (computed assignment target)");
    return fctx.body.splice(start);
  };

  fctx.body.push({ op: "local.get", index: baseLocal });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: emitTypeErrorBranch(),
    else: [],
  });

  const isUndefinedIdx = ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
  flushLateImportShifts(ctx, fctx);
  if (isUndefinedIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: baseLocal });
    fctx.body.push({ op: "call", funcIdx: isUndefinedIdx });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: emitTypeErrorBranch(),
      else: [],
    });
  }
}

/**
 * Evaluate and save a computed key, guard the already-evaluated base, then
 * coerce the key exactly once. This preserves the required order:
 *
 *   base → raw key expression → RequireObjectCoercible(base) → ToPropertyKey
 */
export function compileComputedMemberKeyAfterBaseGuard(
  ctx: CodegenContext,
  fctx: FunctionContext,
  baseLocal: number,
  keyExpression: ts.Expression,
  localPrefix: string,
): number | null {
  const keyResult = compileExpression(ctx, fctx, keyExpression, { kind: "externref" });
  if (!keyResult) return null;

  const keyLocal = allocLocal(fctx, `${localPrefix}_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: keyLocal });
  emitBaseCoercibilityGuard(ctx, fctx, baseLocal);
  fctx.body.push({ op: "local.get", index: keyLocal });
  emitElementStoreKeyOnce(ctx, fctx, baseLocal);
  fctx.body.push({ op: "local.set", index: keyLocal });
  return keyLocal;
}
