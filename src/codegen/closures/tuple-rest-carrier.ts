// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5329) Tuple-typed rest parameters (`function (...args: [Error])`).
 *
 * Most rest parameters lower to the canonical `{ length, data }` vec, and an
 * empty tuple rest (`...args: []`) lowers to a zero-field struct. A NON-EMPTY
 * tuple rest lowers to neither: it becomes a `__tuple_N` struct with one field
 * per tuple element. Every consumer that builds a rest argument had a recipe
 * for the two known carriers and a fallback for "anything else", and both
 * fallbacks were wrong for this shape:
 *
 *  - `calls-closures.ts` padded the formal with `pushDefaultValue(ref …)`,
 *    i.e. `ref.null` + `ref.as_non_null` — a guaranteed "dereferencing a null
 *    pointer" trap on every call;
 *  - `closure-exports.ts` dropped the formal from the host dispatch arm, so the
 *    emitted `call_ref` was one operand short and the WHOLE module failed
 *    validation ("not enough arguments on the stack for call_ref (need 2,
 *    got 1)").
 *
 * jest's `packages/jest-jasmine2/src/queueRunner.ts` is the production witness
 * (`const next = function (...args: [Error]) {…}` plus a `next.fail` twin); it
 * was the only module of the 34 in the jest dogfood suite that failed to
 * validate.
 *
 * This module is the single place that recognizes the carrier and names its
 * field types, so the two builders agree by construction.
 */

import type { ts } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { allocLocal } from "../context/locals.js";
import { coerceType, compileExpression, valTypesMatch } from "../shared.js";
import { defaultValueInstrs, pushDefaultValue } from "../type-coercion.js";

export interface TupleRestCarrier {
  /** The `__tuple_N` struct type index the lifted formal declares. */
  tupleTypeIdx: number;
  /** One entry per tuple element, in field order. */
  fieldTypes: ValType[];
}

/**
 * Recognize a non-empty tuple rest carrier, or `null` when `typeIdx` is not one
 * (or cannot be built safely).
 *
 * Two conditions beyond "struct with fields":
 *
 *  - it must be a REGISTERED tuple type. An arbitrary struct that happens to sit
 *    in a rest formal is not something a positional builder may invent a value
 *    for.
 *  - every field must have a valid missing-argument pad. `defaultValueInstrs`
 *    answers `ref.null` for a `ref`/`ref_null` field, which types as
 *    `(ref null T)` — fine for `ref_null`, ill-typed for a NON-NULL `ref`. A
 *    carrier with such a field is declined rather than built badly.
 */
export function classifyTupleRestCarrier(ctx: CodegenContext, typeIdx: number): TupleRestCarrier | null {
  const def = ctx.mod.types[typeIdx];
  if (def?.kind !== "struct" || def.fields.length === 0) return null;
  let registered = false;
  for (const candidate of ctx.tupleTypeMap.values()) {
    if (candidate === typeIdx) {
      registered = true;
      break;
    }
  }
  if (!registered) return null;
  if (def.fields.some((field) => field.type.kind === "ref")) return null;
  return { tupleTypeIdx: typeIdx, fieldTypes: def.fields.map((field) => field.type) };
}

/**
 * (#5329) Build a struct-shaped rest formal from positional arguments, or
 * answer `null` when `restTypeIdx` is not one — leaving the caller on the vec
 * path.
 *
 * Covers both struct carriers. An EMPTY tuple (`...args: []`) lowers to a
 * zero-field struct and just needs `struct.new`; TypeScript also uses that
 * shape for an unused `...rest`. A NON-EMPTY tuple gets one field per element,
 * in field order: the corresponding call argument when there is one, else that
 * field type's missing-argument default (the f64 `undefined` sentinel / typed
 * null / 0). Arguments past the tuple's width are still EVALUATED — JavaScript
 * ignores surplus arguments but not their side effects — and returned as
 * externref copies so the caller can populate `__extras_argv` for the callee's
 * `arguments` object, exactly as the vec carrier does.
 */
export function compileTupleRestClosureArgument(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callArgs: ts.Expression[],
  fixedParamCount: number,
  restTypeIdx: number,
): { fixedParamCount: number; restExternLocals: number[] } | null {
  const restDef = ctx.mod.types[restTypeIdx];
  if (restDef?.kind === "struct" && restDef.fields.length === 0) {
    fctx.body.push({ op: "struct.new", typeIdx: restTypeIdx });
    return { fixedParamCount, restExternLocals: [] };
  }
  const carrier = classifyTupleRestCarrier(ctx, restTypeIdx);
  if (carrier === null) return null;
  const { tupleTypeIdx, fieldTypes } = carrier;
  const fieldLocals: number[] = [];
  const restExternLocals: number[] = [];
  const captureExtern = (valueLocal: number, valueType: ValType): void => {
    fctx.body.push({ op: "local.get", index: valueLocal });
    coerceType(ctx, fctx, valueType, { kind: "externref" });
    const externLocal = allocLocal(fctx, `__cc_trest_extern_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: externLocal });
    restExternLocals.push(externLocal);
  };

  for (let i = 0; i < fieldTypes.length; i++) {
    const fieldType = fieldTypes[i]!;
    const argIndex = fixedParamCount + i;
    const fieldLocal = allocLocal(fctx, `__cc_trest_${fctx.locals.length}`, fieldType);
    const argument = callArgs[argIndex];
    if (argument === undefined) {
      fctx.body.push(...defaultValueInstrs(fieldType));
    } else {
      const actualType = compileExpression(ctx, fctx, argument, fieldType);
      if (actualType === null) pushDefaultValue(fctx, fieldType, ctx);
      else if (!valTypesMatch(actualType, fieldType)) coerceType(ctx, fctx, actualType, fieldType);
    }
    fctx.body.push({ op: "local.set", index: fieldLocal });
    fieldLocals.push(fieldLocal);
    if (argument !== undefined) captureExtern(fieldLocal, fieldType);
  }

  // Surplus arguments: evaluate for side effects, keep them visible to
  // `arguments`, and do not let them reach the struct.
  for (let argIndex = fixedParamCount + fieldTypes.length; argIndex < callArgs.length; argIndex++) {
    const surplusType = compileExpression(ctx, fctx, callArgs[argIndex]!, { kind: "externref" });
    if (surplusType === null) {
      fctx.body.push({ op: "ref.null.extern" });
    } else if (!valTypesMatch(surplusType, { kind: "externref" })) {
      coerceType(ctx, fctx, surplusType, { kind: "externref" });
    }
    const externLocal = allocLocal(fctx, `__cc_trest_extra_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: externLocal });
    restExternLocals.push(externLocal);
  }

  for (const fieldLocal of fieldLocals) fctx.body.push({ op: "local.get", index: fieldLocal });
  fctx.body.push({ op: "struct.new", typeIdx: tupleTypeIdx });
  return { fixedParamCount, restExternLocals };
}
