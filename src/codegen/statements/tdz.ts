// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Temporal Dead Zone (TDZ) helpers for module-level let/const variables.
 */
import { ts } from "../../ts-api.js";
import type { Instr } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { emitThrowReferenceError, noJsHost } from "../expressions/helpers.js";
import { ensureLateImport, flushLateImportShifts } from "../expressions/late-imports.js";
import { addHostStringConstantGlobal, ensureExnTag } from "../registry/imports.js";

// (#4601 route 1) `collectPatternBindingNames` is a pure-AST walk with no
// CodegenContext in sight; it moved below the IR (`ir/analysis/ast-scope.ts`)
// so `statements/loop-analysis.ts` could follow it down. Re-exported here so
// every existing importer of `tdz.js` is unchanged.
export { collectPatternBindingNames } from "../../ir/analysis/ast-scope.js";

/**
 * Emit instructions to set a TDZ flag global to 1 (initialized) for a module-level
 * let/const variable. No-op if the variable doesn't have a TDZ flag.
 */
export function emitTdzInit(ctx: CodegenContext, fctx: FunctionContext, name: string): void {
  const flagIdx = ctx.tdzGlobals.get(name);
  if (flagIdx === undefined) return;
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "global.set", index: flagIdx });
}

/**
 * Emit instructions to set a local TDZ flag to 1 (initialized) for a function-level
 * let/const variable. No-op if the variable doesn't have a local TDZ flag.
 *
 * Also calls `emitTdzInit` for the module-global case — this is needed when
 * destructuring at the module level (walkStmtForLetConst pre-pass may register
 * a TDZ flag in either tdzGlobals or tdzFlagLocals depending on scope).
 *
 * If the flag has been boxed in an i32 ref cell (because it was captured by
 * a closure — see #1177), the set must go through `struct.set` so the
 * mutation propagates to every closure that captured the same ref cell.
 */
export function emitLocalTdzInit(fctx: FunctionContext, name: string): void {
  const flagIdx = fctx.tdzFlagLocals?.get(name);
  if (flagIdx === undefined) return;
  const boxed = fctx.boxedTdzFlags?.get(name);
  if (boxed) {
    // Boxed: load ref cell, push 1, struct.set field 0
    fctx.body.push({ op: "local.get", index: boxed.localIdx });
    fctx.body.push({ op: "i32.const", value: 1 });
    fctx.body.push({ op: "struct.set", typeIdx: boxed.refCellTypeIdx, fieldIdx: 0 });
    return;
  }
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "local.set", index: flagIdx });
}

/**
 * Emit a TDZ check for a module-level let/const variable read.
 * If the TDZ flag is 0 (uninitialized), throw a ReferenceError.
 * No-op if the variable doesn't have a TDZ flag.
 */
export function emitTdzCheck(ctx: CodegenContext, fctx: FunctionContext, name: string, throwJsError = false): void {
  const flagIdx = ctx.tdzGlobals.get(name);
  if (flagIdx === undefined) return;
  emitTdzCheckAtGlobal(ctx, fctx, flagIdx, name, throwJsError);
}

/** Emit a TDZ check against an exact initialization-flag global. */
export function emitTdzCheckAtGlobal(
  ctx: CodegenContext,
  fctx: FunctionContext,
  flagIdx: number,
  name: string,
  throwJsError = false,
): void {
  if (!throwJsError) {
    const tagIdx = ensureExnTag(ctx);
    fctx.body.push({ op: "global.get", index: flagIdx });
    fctx.body.push({ op: "i32.eqz" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "ref.null.extern" }, { op: "throw", tagIdx }],
      else: [],
    });
    return;
  }

  const msg = `${name} is not defined`;
  // Keep this check's error payload aligned with local TDZ checks. A null
  // exception payload is catchable by Wasm, but does not satisfy JS
  // `assert.throws(ReferenceError, ...)` in the host lane.
  if (noJsHost(ctx)) {
    fctx.body.push({ op: "global.get", index: flagIdx });
    fctx.body.push({ op: "i32.eqz" });
    const savedBody = fctx.body;
    fctx.savedBodies.push(savedBody);
    fctx.body = [];
    emitThrowReferenceError(ctx, fctx, msg);
    fctx.body.push({ op: "unreachable" });
    const then = fctx.body;
    const si = fctx.savedBodies.lastIndexOf(savedBody);
    if (si >= 0) fctx.savedBodies.splice(si, 1);
    fctx.body = savedBody;
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then, else: [] });
    return;
  }

  // if (flag == 0) throw ReferenceError
  // Emit the flag read before settling the real-ReferenceError provider: its
  // constructor/message may insert imports, and the canonical global-index
  // fixup can then relocate this already-live instruction. A numeric flagIdx
  // captured by an exact-source caller cannot be repaired after the fact.
  fctx.body.push({ op: "global.get", index: flagIdx });
  fctx.body.push({ op: "i32.eqz" });
  const throwRefErrIdx = ensureLateImport(ctx, "__throw_reference_error", [{ kind: "externref" }], []);
  flushLateImportShifts(ctx, fctx);
  let then: Instr[];
  if (throwRefErrIdx !== undefined) {
    const strIdx = addHostStringConstantGlobal(ctx, msg);
    if (strIdx !== undefined) {
      then = [{ op: "global.get", index: strIdx }, { op: "call", funcIdx: throwRefErrIdx }, { op: "unreachable" }];
    } else {
      const tagIdx = ensureExnTag(ctx);
      then = [{ op: "ref.null.extern" }, { op: "throw", tagIdx }];
    }
  } else {
    const tagIdx = ensureExnTag(ctx);
    then = [{ op: "ref.null.extern" }, { op: "throw", tagIdx }];
  }
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then, else: [] });
}
