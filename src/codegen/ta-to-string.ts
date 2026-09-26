// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 E7) `%TypedArray%.prototype.toString` on a DETACHED view, for an
 * `any`-typed receiver, host-free.
 *
 * `x.toString()` on an externref receiver lowers, in standalone, to the native
 * `__extern_toString` (call-receiver-method.ts), which renders a dyn view by
 * joining its elements. But `%TypedArray%.prototype.toString` IS
 * `Array.prototype.toString` (§23.2.3.32), whose `this.join()` reaches
 * `%TypedArray%.prototype.join` and its ValidateTypedArray — so a detached
 * view throws a TypeError before anything is rendered
 * (`toString/detached-buffer.js`). `__ta_to_string(recv)` runs the #6501
 * detached prologue and then the unchanged `__extern_toString` call; every
 * other receiver, and an attached view, answers exactly as before.
 *
 * Only reached from a module the pre-scan marks as using dynamic TypedArray
 * views; every other module keeps the direct `__extern_toString` call
 * byte-for-byte.
 *
 * (A §23.2.3.31 `toLocaleString` helper was written alongside this one and
 * dropped: its per-element `Invoke(elem, "toLocaleString")` resolves, for an
 * unpatched Number element, to the standalone `Number.prototype.toLocaleString`
 * value stub, which throws "not yet implemented" — see the #6651 E7 entry.)
 */
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { makeTaDynHelperFctx } from "./dataview-native.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType, getOrRegisterTaDynViewType } from "./registry/types.js";
import { taDynDetachedGuardPrologue } from "./ta-dyn-method-call.js";

/** §7.1.17 ToString, the native the helper falls back to. */
const TO_STRING = "__extern_toString";

/** Does an `any`-receiver `.toString()` in this module need the detach-aware helper? */
export function taToStringApplies(ctx: CodegenContext): boolean {
  return ctx.standalone && ctx.nativeStrings && ctx.moduleUsesDynTaView;
}

/**
 * Mint (or reuse) `__ta_to_string(recv) -> externref`. `callerFctx` is the
 * function being compiled: the fallback native is ensured — and its index
 * shift flushed — against the CALLER first. Returns `undefined` (the caller
 * keeps `__extern_toString`) when a dependency is unavailable.
 */
export function ensureTaToStringHelper(ctx: CodegenContext, callerFctx: FunctionContext): number | undefined {
  const name = "__ta_to_string";
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;
  const externref: ValType = { kind: "externref" };
  const externToStrIdx = ensureLateImport(ctx, TO_STRING, [externref], [externref]);
  flushLateImportShifts(ctx, callerFctx);
  if (externToStrIdx === undefined || !ctx.moduleUsesDynTaView) return undefined;
  getOrRegisterTaDynViewType(ctx);
  const fctx = makeTaDynHelperFctx(name, [{ name: "recv", type: externref }]);
  const guard = taDynDetachedGuardPrologue(ctx, fctx, "toString", 0);
  if (guard.length === 0) return undefined;
  const typeIdx = addFuncType(ctx, [externref], [externref]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(name, funcIdx);
  fctx.body.push(...guard, { op: "local.get", index: 0 }, { op: "call", funcIdx: externToStrIdx });
  pushDefinedFunc(ctx, funcIdx, { name, typeIdx, locals: fctx.locals, body: fctx.body, exported: false });
  return funcIdx;
}
