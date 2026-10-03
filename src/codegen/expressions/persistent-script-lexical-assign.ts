// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { ValType } from "../../ir/types.js";
import type { ts } from "../../ts-api.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { pushBody, popBody } from "../context/bodies.js";
import { compileExpression } from "../expressions.js";
import { coerceType } from "../type-coercion.js";
import { ensureLateImport, flushLateImportShifts } from "../shared.js";
import { emitScriptLexicalOperation, SCRIPT_LEXICAL_OP } from "../shared-script-lexical-access.js";
import {
  emitCaptureGlobalEnvironmentHasBinding,
  emitStrictUnresolvableGlobalWrite,
  emitGlobalEnvironmentKey,
  ensureGlobalEnvironmentOperation,
} from "../global-environment.js";

/** Resolve once before the RHS. A later-created lexical cannot retarget an
 * already resolved global Reference, and const/TDZ errors happen at PutValue. */
export function compilePersistentScriptLexicalAssign(
  ctx: CodegenContext,
  fctx: FunctionContext,
  name: string,
  right: ts.Expression,
  strict: boolean,
): ValType | null {
  const ext: ValType = { kind: "externref" };
  const truthy = ensureLateImport(ctx, "__is_truthy", [ext], [{ kind: "i32" }]);
  flushLateImportShifts(ctx, fctx);
  if (truthy === undefined) throw new Error("Persistent lexical assignment requires native truthiness");
  emitScriptLexicalOperation(ctx, fctx, name, SCRIPT_LEXICAL_OP.has);
  const present = allocLocal(fctx, `__script_lexical_present_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push(
    { op: "call", funcIdx: ctx.funcMap.get("__is_truthy") ?? truthy },
    { op: "local.set", index: present },
  );

  // Only the miss route resolves the object record. Retain its reference across
  // RHS effects instead of probing again after evaluating the assigned value.
  const savedCapture = pushBody(fctx);
  const global = emitCaptureGlobalEnvironmentHasBinding(ctx, fctx, name);
  if (!global) throw new Error("Persistent lexical assignment requires the Context global record");
  const capture = fctx.body;
  popBody(fctx, savedCapture);
  fctx.body.push(
    { op: "local.get", index: present },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: capture },
  );

  const resultType = compileExpression(ctx, fctx, right);
  if (!resultType) return null;
  const result = allocLocal(fctx, `__script_lexical_result_${fctx.locals.length}`, resultType);
  fctx.body.push({ op: "local.set", index: result }, { op: "local.get", index: result });
  if (resultType.kind !== "externref") coerceType(ctx, fctx, resultType, ext);
  const value = allocLocal(fctx, `__script_lexical_value_${fctx.locals.length}`, ext);
  fctx.body.push({ op: "local.set", index: value });

  const savedWrite = pushBody(fctx);
  emitScriptLexicalOperation(ctx, fctx, name, SCRIPT_LEXICAL_OP.write, value);
  fctx.body.push({ op: "drop" });
  const write = fctx.body;
  popBody(fctx, savedWrite);
  fctx.savedBodies.push(write);
  const savedMiss = pushBody(fctx);
  if (strict) {
    emitStrictUnresolvableGlobalWrite(ctx, fctx, name, global.objLocalIdx, global.hasLocalIdx, value);
  } else {
    const set = ensureGlobalEnvironmentOperation(ctx, fctx, "__extern_set");
    if (set === undefined) throw new Error("Persistent lexical assignment requires native global writes");
    fctx.body.push({ op: "local.get", index: global.objLocalIdx });
    emitGlobalEnvironmentKey(ctx, fctx, name);
    fctx.body.push({ op: "local.get", index: value }, { op: "call", funcIdx: ctx.funcMap.get("__extern_set") ?? set });
    // A conditional global miss must not classify all later reads of this
    // spelling as implicit globals: the hit route is a declarative binding.
  }
  const miss = fctx.body;
  popBody(fctx, savedMiss);
  fctx.savedBodies.splice(fctx.savedBodies.lastIndexOf(write), 1);
  fctx.body.push(
    { op: "local.get", index: present },
    { op: "if", blockType: { kind: "empty" }, then: write, else: miss },
    { op: "local.get", index: result },
  );
  return resultType;
}
