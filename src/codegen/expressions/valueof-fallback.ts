// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { ValType } from "../../ir/types.js";
import type { ts } from "../../ts-api.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { tryEmitDynamicValueOfCall } from "../wrapper-valueof.js";
import { compileExpression } from "../shared.js";
import { sourceOverridesMethodOnReceiver } from "./member-override-scan.js";

/** Apply Object.prototype.valueOf only when no live compiled override may exist. */
export function tryEmitValueOfFallback(
  ctx: CodegenContext,
  fctx: FunctionContext,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): ValType | null | undefined {
  if (access.name.text !== "valueOf" || call.arguments.length !== 0) return undefined;
  // (#4482) The program installed its OWN `valueOf` on THIS binding
  // (`s.valueOf = Number.prototype.valueOf` / `Object.defineProperty(s,
  // "valueOf", …)`). Neither answer below is then correct:
  //  * `__dyn_valueOf` only probes `$Object` receivers, so a `$Date`/closed
  //    struct falls to its identity arm;
  //  * the blanket `compileExpression` IS `Object.prototype.valueOf`.
  // Both answer the RECEIVER where §15.7.4.4 requires the transferred
  // intrinsic to run and throw a real `TypeError`. Declining hands the call to
  // the stored-member closure arm, which reads the own slot and applies it
  // with the original `this` — the reflective body's brand preamble does the
  // rest (verified: the expando-named half, `s.myValueOf = …`, already threw).
  //
  // Receiver-precise, so a module that does not override `valueOf` on this
  // binding compiles byte-identically. Measured flips:
  // `Number/prototype/valueOf/S15.7.4.4_A2_T0{3,4,5}` block #1.
  if (ctx.standalone && sourceOverridesMethodOnReceiver(access.expression, "valueOf")) return undefined;
  const receiverFact = ctx.oracle.typeFactOf(access.expression).kind;
  const dynamicReceiver = receiverFact === "any" || receiverFact === "unknown";
  if (!ctx.standalone && dynamicReceiver) return undefined;
  return tryEmitDynamicValueOfCall(ctx, fctx, access) ?? compileExpression(ctx, fctx, access.expression);
}
