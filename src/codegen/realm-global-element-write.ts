// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4491 T4) The BRACKET spelling of #4500 Slice A's realm-global WRITE —
 * `this["p"] = v` / `globalThis["p"] = v` where `p` is a `var`-declared script
 * global.
 *
 * ## The defect
 *
 * §13.3.3 makes `o.p` and `o["p"]` the same reference, so a `var`-declared
 * script global has to answer the same way through both. The compiler's
 * global-object model reached that state in three separate steps and, until
 * this one, was consistent through neither:
 *
 * | spelling | read | write |
 * | --- | --- | --- |
 * | `this.p` | module global (#4500 Slice A) | module global (#4500 Slice A) |
 * | `this["p"]` | module global (`tryEmitRealmGlobalModuleGlobalElementRead`) | **realm OBJECT** ← the gap |
 *
 * With the bracket read already fixed, the bracket write went to a property on
 * the realm global object that nothing ever reads back:
 *
 * ```js
 * this['__declared__var'] = "baloon";
 * this['__declared__var'];   // undefined  — read consults the module global
 * __declared__var;           // undefined  — so does the bare identifier
 * var __declared__var;
 * ```
 *
 * That is `S12.2_A11` exactly, and it is the mirror of the hazard #4500 Slice A
 * already documents in the opposite direction ("fixing only the read makes
 * `this.p = 2; this.p === 2` regress"). A half-fixed pair is worse than neither
 * half, because the write silently lands somewhere the read cannot see.
 *
 * ## Scope
 *
 * Only a key the compiler resolves to a fixed string, only a receiver
 * `receiverIsRealmGlobalObject` proves is the realm global, and only a name that
 * already HAS a wasm module global. Everything else declines and the existing
 * dynamic element-write path runs byte-for-byte.
 */
import type { ts } from "../ts-api.js";
import type { InnerResult } from "./shared.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { receiverIsRealmGlobalObject } from "./helpers/sloppy-this-global.js";
import { localGlobalIdx } from "./registry/imports.js";
import { coerceType, compileExpression, resolveComputedKeyExpression } from "./shared.js";

/**
 * Emit `this["p"] = v` as a write to `p`'s wasm module global, or return
 * `undefined` to decline (leaving the caller's existing lowering untouched).
 */
export function tryEmitRealmGlobalElementWrite(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.ElementAccessExpression,
  value: ts.Expression,
): InnerResult | undefined {
  if (!receiverIsRealmGlobalObject(ctx, fctx, target.expression)) return undefined;
  const key = resolveComputedKeyExpression(ctx, target.argumentExpression);
  if (key === undefined) return undefined;
  const globalIdx = ctx.moduleGlobals.get(key);
  if (globalIdx === undefined) return undefined;

  const globalType = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)]?.type;
  const rhsType = compileExpression(ctx, fctx, value, globalType);
  if (!rhsType) return null;
  if (globalType && rhsType.kind !== globalType.kind) coerceType(ctx, fctx, rhsType, globalType);
  // §13.15.2: the assignment expression evaluates to the assigned value, so tee
  // it aside before the `global.set` consumes it.
  const resultLocal = allocLocal(fctx, `__realm_global_elem_write_${fctx.locals.length}`, globalType ?? rhsType);
  fctx.body.push({ op: "local.tee", index: resultLocal });
  fctx.body.push({ op: "global.set", index: globalIdx });
  fctx.body.push({ op: "local.get", index: resultLocal });
  return globalType ?? rhsType;
}
