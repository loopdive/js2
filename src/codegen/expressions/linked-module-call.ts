// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { allocLocal } from "../context/locals.js";
import { linkedModuleCall } from "../linked-module-namespace.js";
import { LINKED_RESOLVED_CALL, reserveLinkedResolvedCall } from "../linked-realm-method-call.js";
import { reserveLinkedRealmPropertyRead } from "../linked-realm-property-read.js";
import { ensureObjVecBuilders, reserveApplyClosure } from "../object-runtime.js";
import { stringConstantExternrefInstrs } from "../native-strings.js";
import { coerceType, compileExpression } from "../shared.js";
import { compileInternalCallArgument } from "./internal-call-argument.js";
import { compileComputedMemberKeyAfterBaseGuard } from "./computed-member-reference.js";
import { ensureLateImport, flushLateImportShifts } from "./late-imports.js";

/** Resolve once before args; dispatch in the callable's allocation owner.
 * Structural closure compatibility does not share the owner's `this` global. */
export function tryCompileLinkedModuleCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): ValType | undefined {
  if (!linkedModuleCall(ctx, expr.expression)) return undefined;
  if (ts.isOptionalChain(expr) || expr.arguments.some(ts.isSpreadElement)) return undefined;
  const provider = ctx.standaloneGlobalThisImport;
  if (!provider?.owns || !provider.get || !provider.call)
    throw new Error("Linked module calls require owner-aware get/call providers");
  reserveLinkedRealmPropertyRead(ctx);
  ensureObjVecBuilders(ctx);
  reserveApplyClosure(ctx);
  reserveLinkedResolvedCall(ctx);
  ensureLateImport(ctx, "__extern_get", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  const receiver = allocLocal(fctx, "linkedImportReceiver", { kind: "externref" });
  const callee = allocLocal(fctx, "linkedImportCallee", { kind: "externref" });
  const args = allocLocal(fctx, "linkedImportArgs", { kind: "externref" });
  const emitValue = (value: ts.Expression): void => {
    const type = compileExpression(ctx, fctx, value, { kind: "externref" });
    if (type === null) throw new Error("Linked module call value could not be compiled");
    if (type.kind !== "externref") coerceType(ctx, fctx, type, { kind: "externref" });
  };
  const member = expr.expression;
  if (ts.isPropertyAccessExpression(member) || ts.isElementAccessExpression(member)) {
    emitValue(member.expression);
    fctx.body.push({ op: "local.set", index: receiver });
    const key = ts.isElementAccessExpression(member)
      ? compileComputedMemberKeyAfterBaseGuard(ctx, fctx, receiver, member.argumentExpression, "linkedImportKey")
      : undefined;
    if (key === null) throw new Error("Linked module call key could not be compiled");
    const literal = ts.isPropertyAccessExpression(member) ? stringConstantExternrefInstrs(ctx, member.name.text) : [];
    flushLateImportShifts(ctx, fctx);
    const get = ctx.funcMap.get("__extern_get")!;
    fctx.body.push(
      { op: "local.get", index: receiver },
      ...(key === undefined ? literal : [{ op: "local.get" as const, index: key }]),
      { op: "call", funcIdx: get },
    );
  } else {
    emitValue(member);
  }
  fctx.body.push({ op: "local.set", index: callee });
  const values: number[] = [];
  for (const argument of expr.arguments) {
    compileInternalCallArgument(ctx, fctx, argument, { kind: "externref" });
    const local = allocLocal(fctx, "linkedImportArgument", { kind: "externref" });
    fctx.body.push({ op: "local.set", index: local });
    values.push(local);
  }
  flushLateImportShifts(ctx, fctx);
  const make = ctx.funcMap.get("__objvec_new")!;
  const push = ctx.funcMap.get("__objvec_push")!;
  const call = ctx.funcMap.get(LINKED_RESOLVED_CALL)!;
  fctx.body.push({ op: "call", funcIdx: make }, { op: "local.set", index: args });
  for (const index of values)
    fctx.body.push({ op: "local.get", index: args }, { op: "local.get", index }, { op: "call", funcIdx: push });
  fctx.body.push(
    { op: "local.get", index: callee },
    { op: "local.get", index: receiver },
    { op: "local.get", index: args },
    { op: "call", funcIdx: call },
  );
  return { kind: "externref" };
}
