// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#2917) Builtin Array methods on a standalone `class X extends Array` receiver.
//
// Standalone/WASI build every Array-subclass instance through
// `emitStandaloneArrayConstructor`, so the runtime value is always a real
// `$__vec_externref`. Its STATIC value type, though, is `externref`
// (`externrefBackedClassValType`, #5201), and `resolveArrayInfo` answers `null`
// for it. `compileArrayMethodCall` therefore declined every inherited method
// (`p.slice(1)`, `p.splice(…)`, `super.push(v)`, …) and the call fell to the
// closed-method dispatcher, whose `$__vec_base` arms cover only a few names —
// `slice` returned null (trap on the next use), `splice`/`shift`/`unshift` did
// nothing, `super.push(v)` did not compile.
//
// The fix keeps the value representation and the dispatcher untouched: the
// receiver is evaluated ONCE, cast back to its vec (`coerceType`
// externref → `ref_null $__vec_externref` tests the brand and only copies a
// foreign value), spilled to a local, and the ordinary vec lowering reads that
// local in place of the receiver expression (the `nativeGeneratorExpression
// ValueLocals` override `compileExpression` already honours for any node). The
// vec is the instance itself, so mutating methods mutate the instance.
//
// Not in scope: @@species. `slice`/`map`/`filter` return a plain Array, as the
// closed dispatcher did before; `speciesMap` needs ArraySpeciesCreate.

import type { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { rollbackSpeculative, snapshotSpeculative } from "./context/speculative.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { getOrRegisterVecType } from "./registry/types.js";
import { coerceType } from "./shared.js";

/**
 * True when `className` (a class or class-expression display name) is a
 * standalone/WASI externref-backed subclass whose builtin root is `Array`.
 */
export function isStandaloneArraySubclass(ctx: CodegenContext, className: string | undefined): boolean {
  if (!(ctx.standalone || ctx.wasi) || className === undefined) return false;
  const name = ctx.classExprNameMap.get(className) ?? className;
  return ctx.classExternrefBackedSet.has(name) && ctx.classBuiltinParentMap.get(name) === "Array";
}

/**
 * Compile `lower()` with `receiverExpr` pre-evaluated into a
 * `$__vec_externref` local. `emitReceiver` pushes the receiver's value (any
 * type). Returns `undefined` — with every emission rolled back — when
 * `lower()` declines, so the caller's fallback evaluates the receiver itself.
 */
export function withArraySubclassReceiverAsVec<T>(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiverExpr: ts.Expression,
  emitReceiver: () => ValType | null,
  lower: () => T | undefined,
): T | undefined {
  const overrides = (fctx.nativeGeneratorExpressionValueLocals ??= new Map());
  if (overrides.has(receiverExpr)) return undefined;
  const snap = snapshotSpeculative(ctx, fctx);
  const recvType = emitReceiver();
  if (recvType === null) {
    rollbackSpeculative(ctx, fctx, snap);
    return undefined;
  }
  const vecType: ValType = { kind: "ref_null", typeIdx: getOrRegisterVecType(ctx, "externref", { kind: "externref" }) };
  coerceType(ctx, fctx, recvType, vecType);
  const vecLocal = allocLocal(fctx, `__arrsub_recv_${fctx.locals.length}`, vecType);
  fctx.body.push({ op: "local.set", index: vecLocal });
  overrides.set(receiverExpr, vecLocal);
  try {
    const result = lower();
    if (result === undefined) rollbackSpeculative(ctx, fctx, snap);
    return result;
  } finally {
    overrides.delete(receiverExpr);
  }
}

/**
 * Closed-dispatcher `$__vec_base` mutator arm (`push`/`pop` on an `any`
 * receiver): when some Array subclass declares an instance method `methodName`,
 * its instances carry that method as an own property (#3537 bag,
 * standalone-subclass-method-install.ts), which must win over the builtin.
 * Appended after the arm's `ref.test` (i32 on the stack), the returned
 * instructions clear the claim for a receiver (param 0) owning `methodName`, so
 * the call falls to the generic arm that invokes the own method. Empty — the
 * arm is byte-identical — when no Array subclass declares that name.
 */
export function arraySubclassOwnMethodShadowTest(ctx: CodegenContext, methodName: string): Instr[] {
  const hasOwnIdx = ctx.funcMap.get("__hasOwnProperty");
  if (hasOwnIdx === undefined) return [];
  let declared = false;
  for (const cls of ctx.classExternrefBackedSet) {
    if (isStandaloneArraySubclass(ctx, cls) && ctx.classMethodSet.has(`${cls}_${methodName}`)) declared = true;
  }
  if (!declared) return [];
  addStringConstantGlobal(ctx, methodName);
  return [
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: 0 },
        ...stringConstantExternrefInstrs(ctx, methodName),
        { op: "call", funcIdx: hasOwnIdx },
        { op: "i32.eqz" },
      ],
      else: [{ op: "i32.const", value: 0 }],
    },
  ];
}
