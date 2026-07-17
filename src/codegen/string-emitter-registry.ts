// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3324) Leaf registry for the two string-helper emitters the coercion
 * engine borrows from string-ops.ts (#1917 Step 1).
 *
 * ## Why a separate module
 *
 * `emitBoolToString` / `emitNativeStringRefFromExternref` are defined in
 * string-ops.ts and not exported; string-ops.ts imports coercion-engine.ts,
 * so a direct import in the engine would be a cycle. The old wiring kept the
 * mutable slots + `registerStringHelperEmitters` INSIDE coercion-engine.ts
 * and had string-ops.ts call the register at module top level. That is
 * initialization-ORDER-dependent: when module evaluation enters
 * coercion-engine.ts first (e.g. an entry importing `any-helpers.js` before
 * anything that pulls string-ops — tests/issue-2949-s5-2-eq.test.ts), the
 * engine's import chain (`./index.js` → … → expressions/builtins.ts →
 * string-ops.ts) re-enters the register call while coercion-engine.ts is
 * still mid-initialization, and the assignment to its top-level `let` slots
 * throws `ReferenceError: Cannot access 'boolToStringEmitter' before
 * initialization` (TDZ).
 *
 * This module breaks that structurally: it has NO runtime imports (types
 * only, erased at emit), so it can never be partially initialized when either
 * party touches it — its own body always completes before any importer
 * proceeds. Both sides depend downward on this leaf; the registration is
 * order-immune.
 */
import type { CodegenContext, FunctionContext } from "./context/types.js";

export type StringHelperEmitter = (ctx: CodegenContext, fctx: FunctionContext) => void;

let boolToStringEmitter: StringHelperEmitter | undefined;
let nativeStringRefFromExternrefEmitter: StringHelperEmitter | undefined;

/** Bound by string-ops.ts at its module load (#1917 Step 1). */
export function registerStringHelperEmitters(emitters: {
  boolToString: StringHelperEmitter;
  nativeStringRefFromExternref: StringHelperEmitter;
}): void {
  boolToStringEmitter = emitters.boolToString;
  nativeStringRefFromExternrefEmitter = emitters.nativeStringRefFromExternref;
}

export function getBoolToStringEmitter(): StringHelperEmitter | undefined {
  return boolToStringEmitter;
}

export function getNativeStringRefFromExternrefEmitter(): StringHelperEmitter | undefined {
  return nativeStringRefFromExternrefEmitter;
}
