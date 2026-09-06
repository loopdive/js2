// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { pushBody, popBody } from "./context/bodies.js";
import { resolveWasmType } from "./index.js";
import { compileExpression, coerceType } from "./shared.js";
import { getVecInfo } from "./type-coercion.js";
import { materializeStructAsDynamicObject } from "./literals.js";
import { ensureObjVecBuilders } from "./object-runtime.js";
import { canonicalUndefinedExternInstrs } from "./any-helpers.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";

/** The compact JSON route can safely snapshot flat, data-only record fields. */
export function jsonRecordArrayLayout(ctx: CodegenContext, value: ts.Expression) {
  while (ts.isAsExpression(value) || ts.isTypeAssertionExpression(value) || ts.isParenthesizedExpression(value)) {
    value = value.expression;
  }
  const sourceType = ctx.checker.getTypeAtLocation(value);
  const type = resolveWasmType(ctx, sourceType);
  if (type.kind !== "ref" && type.kind !== "ref_null") return undefined;
  const vec = getVecInfo(ctx, type.typeIdx);
  if (!vec || (vec.elemType.kind !== "ref" && vec.elemType.kind !== "ref_null")) return undefined;
  const name = ctx.typeIdxToStructName.get(vec.elemType.typeIdx);
  if (name !== undefined && ctx.classSet.has(name)) return undefined;
  const fields = name === undefined ? undefined : ctx.structFields.get(name);
  const sourceElement = sourceType.getNumberIndexType();
  const scalarProperty = (name: string): boolean => {
    const property = sourceElement?.getProperty(name);
    if (!property) return false;
    const propertyType = ctx.checker.getTypeOfSymbolAtLocation(property, value);
    const variants = propertyType.isUnion() ? propertyType.types : [propertyType];
    return variants.every(
      (type) =>
        (type.flags &
          (ts.TypeFlags.StringLike |
            ts.TypeFlags.NumberLike |
            ts.TypeFlags.BooleanLike |
            ts.TypeFlags.Null |
            ts.TypeFlags.Undefined)) !==
        0,
    );
  };
  if (
    !fields?.length ||
    fields.some(
      (field) =>
        field.name === "toJSON" ||
        field.name.startsWith("__") ||
        !(
          field.type.kind === "f64" ||
          field.type.kind === "i32" ||
          (field.type.kind === "externref" && scalarProperty(field.name)) ||
          ((field.type.kind === "ref" || field.type.kind === "ref_null") && field.type.typeIdx === ctx.anyStrTypeIdx)
        ),
    )
  ) {
    return undefined;
  }
  const undefinedStringFields = fields.flatMap((field, index) => {
    if ((field.type.kind !== "ref_null" && field.type.kind !== "ref") || field.type.typeIdx !== ctx.anyStrTypeIdx)
      return [];
    const property = sourceElement?.getProperty(field.name);
    if (!property) return [];
    const propertyType = ctx.checker.getTypeOfSymbolAtLocation(property, value);
    const variants = propertyType.isUnion() ? propertyType.types : [propertyType];
    return ((property.flags & ts.SymbolFlags.Optional) !== 0 ||
      variants.some((type) => (type.flags & ts.TypeFlags.Undefined) !== 0)) &&
      !variants.some((type) => (type.flags & ts.TypeFlags.Null) !== 0)
      ? [{ name: field.name, index }]
      : [];
  });
  return { type, arrTypeIdx: vec.arrTypeIdx, elementType: vec.elemType, undefinedStringFields };
}

/** Leave an ObjVec of open records on the stack; evaluate the array only once. */
export function emitJsonRecordArray(ctx: CodegenContext, fctx: FunctionContext, value: ts.Expression): boolean {
  const layout = jsonRecordArrayLayout(ctx, value);
  if (!layout) return false;
  ensureObjVecBuilders(ctx);
  const actual = compileExpression(ctx, fctx, value);
  if (!actual) return false;
  const nullableVec = { kind: "ref_null" as const, typeIdx: layout.type.typeIdx };
  coerceType(ctx, fctx, actual, nullableVec);
  const vec = allocLocal(fctx, `__json_records_${fctx.locals.length}`, nullableVec);
  const out = allocLocal(fctx, `__json_records_out_${fctx.locals.length}`, { kind: "externref" });
  const index = allocLocal(fctx, `__json_records_index_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push(
    { op: "local.set", index: vec },
    { op: "call", funcIdx: ctx.funcMap.get("__objvec_new")! },
    { op: "local.set", index: out },
    { op: "i32.const", value: 0 },
    { op: "local.set", index },
  );
  const saved = pushBody(fctx);
  const loop = fctx.body;
  try {
    fctx.body.push(
      { op: "local.get", index },
      { op: "local.get", index: vec },
      { op: "struct.get", typeIdx: layout.type.typeIdx, fieldIdx: 0 },
      { op: "i32.ge_u" },
      { op: "br_if", depth: 1 },
      { op: "local.get", index: out },
      { op: "local.get", index: vec },
      { op: "struct.get", typeIdx: layout.type.typeIdx, fieldIdx: 1 },
      { op: "local.get", index },
      { op: "array.get", typeIdx: layout.arrTypeIdx },
    );
    emitNullableRecord(ctx, fctx, layout.elementType.typeIdx, layout.undefinedStringFields);
    fctx.body.push(
      { op: "call", funcIdx: ctx.funcMap.get("__objvec_push")! },
      { op: "local.get", index },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "local.set", index },
      { op: "br", depth: 0 },
    );
  } finally {
    popBody(fctx, saved);
  }
  fctx.body.push(
    { op: "local.get", index: vec },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [{ op: "ref.null.extern" }],
      else: [
        { op: "block", blockType: { kind: "empty" }, body: [{ op: "loop", blockType: { kind: "empty" }, body: loop }] },
        { op: "local.get", index: out },
      ],
    },
  );
  return true;
}

function emitNullableRecord(
  ctx: CodegenContext,
  fctx: FunctionContext,
  typeIdx: number,
  undefinedStringFields: { name: string; index: number }[],
): void {
  const record = allocLocal(fctx, `__json_record_${fctx.locals.length}`, { kind: "ref_null", typeIdx });
  fctx.body.push({ op: "local.set", index: record });
  const saved = pushBody(fctx);
  const materialized = fctx.body;
  try {
    fctx.body.push({ op: "local.get", index: record });
    if (!materializeStructAsDynamicObject(ctx, fctx, typeIdx)) throw new Error("missing JSON record layout");
    const object = allocLocal(fctx, `__json_record_object_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: object });
    for (const field of undefinedStringFields) {
      addStringConstantGlobal(ctx, field.name);
      const undefinedValue = canonicalUndefinedExternInstrs(ctx);
      fctx.body.push(
        { op: "local.get", index: record },
        { op: "struct.get", typeIdx, fieldIdx: field.index },
        { op: "ref.is_null" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: object },
            ...stringConstantExternrefInstrs(ctx, field.name),
            ...undefinedValue,
            { op: "call", funcIdx: ctx.funcMap.get("__extern_set")! },
          ],
        },
      );
    }
    fctx.body.push({ op: "local.get", index: object });
  } finally {
    popBody(fctx, saved);
  }
  fctx.body.push(
    { op: "local.get", index: record },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [{ op: "ref.null.extern" }],
      else: materialized,
    },
  );
}
