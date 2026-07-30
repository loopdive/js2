// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { FieldDef, Instr, ValType } from "../ir/types.js";
import type { ts } from "../ts-api.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { FNCTOR_CONSTRUCTOR_FIELD } from "./fnctor-identity-fields.js";
import { coerceType, compileExpression } from "./shared.js";
import { pushDefaultValue } from "./type-coercion.js";

/** Add the exact runtime callee as the hidden trailing constructor parameter. */
export function fnctorConstructorParams(ctx: CodegenContext, userParams: ValType[]): ValType[] {
  return ctx.standalone ? [...userParams, { kind: "externref" }] : userParams;
}

/** Add the hidden parameter definition without shifting user parameter indices. */
export function appendFnctorConstructorParam(ctx: CodegenContext, params: { name: string; type: ValType }[]): void {
  if (ctx.standalone) params.push({ name: "__constructor_identity", type: { kind: "externref" } });
}

/**
 * Initialize the native fnctor instance. The constructor identity is installed
 * before the user body runs; every other field retains its legacy zero/null
 * initializer.
 */
export function emitFnctorFieldInitializers(
  ctx: CodegenContext,
  fctx: FunctionContext,
  fields: FieldDef[],
  constructorIdentityParamIdx: number,
): void {
  for (const field of fields) {
    let instr: Instr;
    if (ctx.standalone && field.name === FNCTOR_CONSTRUCTOR_FIELD) {
      instr = { op: "local.get", index: constructorIdentityParamIdx };
    } else if (field.type.kind === "f64") {
      instr = { op: "f64.const", value: 0 };
    } else if (field.type.kind === "i32") {
      instr = { op: "i32.const", value: 0 };
    } else if (field.type.kind === "i64") {
      instr = { op: "i64.const", value: 0n };
    } else if (field.type.kind === "externref") {
      instr = { op: "ref.null.extern" };
    } else if (field.type.kind === "ref_null" || field.type.kind === "ref") {
      instr = { op: "ref.null", typeIdx: field.type.typeIdx };
    } else {
      instr = { op: "i32.const", value: 0 };
    }
    fctx.body.push(instr);
  }
}

/**
 * Evaluate and park the exact callee before user arguments, then append it
 * after those arguments for the synthesized native constructor signature.
 */
export function emitFnctorConstructorArguments(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callee: ts.Expression,
  args: readonly ts.Expression[],
  userParamTypes: ValType[] | undefined,
): void {
  let constructorIdentityLocal: number | undefined;
  if (ctx.standalone) {
    const valueType = compileExpression(ctx, fctx, callee, { kind: "externref" });
    if (!valueType) {
      fctx.body.push({ op: "ref.null.extern" });
    } else if (valueType.kind !== "externref" && valueType.kind !== "ref_extern") {
      coerceType(ctx, fctx, valueType, { kind: "externref" });
    }
    constructorIdentityLocal = allocLocal(fctx, `__fnctor_ctor_value_${fctx.locals.length}`, {
      kind: "externref",
    });
    fctx.body.push({ op: "local.set", index: constructorIdentityLocal });
  }

  for (let i = 0; i < args.length; i++) {
    compileExpression(ctx, fctx, args[i]!, userParamTypes?.[i]);
  }
  for (let i = args.length; i < (userParamTypes?.length ?? 0); i++) {
    pushDefaultValue(fctx, userParamTypes![i]!, ctx);
  }
  if (constructorIdentityLocal !== undefined) {
    fctx.body.push({ op: "local.get", index: constructorIdentityLocal });
  }
}
