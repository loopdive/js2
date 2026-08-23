// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * Backend-neutral ABI contract for function-style constructors (fnctors).
 *
 * This module is intentionally independent of AST propagation and codegen
 * context.  It records the identity/layout facts that a future `fnctor.new`
 * and `fnctor.get` implementation must prove before crossing into lowering.
 * No existing IrType or instruction is widened here; an absent resolver keeps
 * the current dynamic/legacy path unchanged.
 */

import type { IrSourceId, IrUnitId } from "./identity.js";
import { irTypeEquals, type IrType, type IrTypeRef } from "./nodes.js";
import type { IrFuncRef } from "./value-references.js";

export interface IrFnctorField {
  readonly name: string;
  readonly type: IrType;
  /** Stable field ordinal in the reserved constructor layout. */
  readonly ordinal: number;
}

export interface IrFnctorCapture {
  readonly name: string;
  readonly type: IrType;
  /** Whether this capture carries the paired TDZ flag parameter. */
  readonly hasTdzFlag: boolean;
  /** Stable capture ordinal in the constructor ABI. */
  readonly ordinal: number;
}

/**
 * Nominal, source-qualified shape of one approved function-style constructor.
 * `name` fields are diagnostics only; source/unit/layout bindings are the
 * semantic identity and must be checked by every resolver.
 */
export interface IrFnctorShape {
  readonly kind: "fnctor-shape";
  readonly sourceId: IrSourceId;
  readonly constructorUnitId: IrUnitId;
  readonly constructorName: string;
  readonly constructorTarget: IrFuncRef;
  /** Symbolic identity of the reserved `__fnctor_<name>` struct layout. */
  readonly reservedLayout: IrTypeRef;
  readonly fields: readonly IrFnctorField[];
  readonly captures: readonly IrFnctorCapture[];
  readonly userParamTypes: readonly IrType[];
  /** Identity argument is always the final synthesized constructor argument. */
  readonly constructorIdentity: {
    readonly unitId: IrUnitId;
    readonly paramIndex: number;
  };
}

/** Backend result of resolving a nominal shape against finalized ABI state. */
export interface IrFnctorResolution {
  readonly shape: IrFnctorShape;
  readonly structType: IrTypeRef;
  readonly constructor: IrFuncRef;
  readonly captureParamTypes: readonly IrType[];
  readonly userParamTypes: readonly IrType[];
  readonly constructorIdentityParamIndex: number;
  /** True only for the standalone/WASI foreign-return constructor ABI. */
  readonly resultIsExternref: boolean;
}

/** Lowering seam; implementations must return null rather than guessing. */
export interface IrFnctorLowerResolver {
  resolveFnctor(shape: IrFnctorShape): IrFnctorResolution | null;
}

function nonEmpty(value: string): boolean {
  return value.length > 0 && !value.includes("\0") && !value.includes("\r") && !value.includes("\n");
}

function validateRef(ref: { readonly kind: string; readonly name: string }, label: string): string | null {
  if (ref.kind !== "func" && ref.kind !== "type") return `${label} has an invalid symbolic kind`;
  return nonEmpty(ref.name) ? null : `${label} has an empty diagnostic name`;
}

function validateFields(fields: readonly IrFnctorField[], label: string): string | null {
  const names = new Set<string>();
  const ordinals = new Set<number>();
  for (const field of fields) {
    if (!nonEmpty(field.name)) return `${label} contains an empty field name`;
    if (names.has(field.name)) return `${label} contains duplicate field ${field.name}`;
    if (!Number.isSafeInteger(field.ordinal) || field.ordinal < 0 || ordinals.has(field.ordinal)) {
      return `${label} contains an invalid/duplicate field ordinal`;
    }
    names.add(field.name);
    ordinals.add(field.ordinal);
  }
  return null;
}

function validateCaptures(captures: readonly IrFnctorCapture[]): string | null {
  const names = new Set<string>();
  const ordinals = new Set<number>();
  for (const capture of captures) {
    if (!nonEmpty(capture.name)) return "fnctor captures contain an empty name";
    if (names.has(capture.name)) return `fnctor captures contain duplicate ${capture.name}`;
    if (!Number.isSafeInteger(capture.ordinal) || capture.ordinal < 0 || ordinals.has(capture.ordinal)) {
      return "fnctor captures contain an invalid/duplicate ordinal";
    }
    names.add(capture.name);
    ordinals.add(capture.ordinal);
  }
  return null;
}

function validateTypeGraph(type: IrType, activeTypes: Set<object>, activeShapes: Set<object>): string | null {
  if (type.kind === "val" || type.kind === "string" || type.kind === "dynamic" || type.kind === "extern") return null;
  if (activeTypes.has(type)) return "fnctor shape contains a recursive IR type graph";
  activeTypes.add(type);
  try {
    switch (type.kind) {
      case "fnctor":
        return validateShapeGraph(type.shape, activeTypes, activeShapes);
      case "vec":
        return validateTypeGraph(type.elementType, activeTypes, activeShapes);
      case "object":
        for (const field of type.shape.fields) {
          const error = validateTypeGraph(field.type, activeTypes, activeShapes);
          if (error) return error;
        }
        return null;
      case "closure":
      case "callable":
        for (const param of type.signature.params) {
          const error = validateTypeGraph(param, activeTypes, activeShapes);
          if (error) return error;
        }
        return type.signature.returnType === null
          ? null
          : validateTypeGraph(type.signature.returnType, activeTypes, activeShapes);
      case "class":
        for (const field of type.shape.fields) {
          const error = validateTypeGraph(field.type, activeTypes, activeShapes);
          if (error) return error;
        }
        return null;
      case "union":
        for (const member of type.members) {
          const error = validateTypeGraph(member, activeTypes, activeShapes);
          if (error) return error;
        }
        return null;
      case "boxed":
        return validateTypeGraph(type.inner, activeTypes, activeShapes);
    }
  } finally {
    activeTypes.delete(type);
  }
}

function validateShapeGraph(shape: IrFnctorShape, activeTypes: Set<object>, activeShapes: Set<object>): string | null {
  if (activeShapes.has(shape)) return "fnctor shape contains a recursive shape graph";
  activeShapes.add(shape);
  try {
    const shapeError = validateShapeScalars(shape);
    if (shapeError) return shapeError;
    for (const field of shape.fields) {
      const error = validateTypeGraph(field.type, activeTypes, activeShapes);
      if (error) return error;
    }
    for (const capture of shape.captures) {
      const error = validateTypeGraph(capture.type, activeTypes, activeShapes);
      if (error) return error;
    }
    for (const param of shape.userParamTypes) {
      const error = validateTypeGraph(param, activeTypes, activeShapes);
      if (error) return error;
    }
    return null;
  } finally {
    activeShapes.delete(shape);
  }
}

function validateShapeScalars(shape: IrFnctorShape): string | null {
  if (shape.kind !== "fnctor-shape") return "fnctor shape has an invalid kind";
  if (!nonEmpty(shape.sourceId)) return "fnctor shape has an empty source identity";
  if (!nonEmpty(shape.constructorUnitId)) return "fnctor shape has an empty constructor identity";
  if (!nonEmpty(shape.constructorName)) return "fnctor shape has an empty constructor name";
  const targetError = validateRef(shape.constructorTarget, "fnctor constructor target");
  if (targetError) return targetError;
  const layoutError = validateRef(shape.reservedLayout, "fnctor reserved layout");
  if (layoutError) return layoutError;
  if (shape.reservedLayout.kind !== "type") return "fnctor reserved layout is not a type reference";
  const fieldError = validateFields(shape.fields, "fnctor fields");
  if (fieldError) return fieldError;
  const captureError = validateCaptures(shape.captures);
  if (captureError) return captureError;
  if (!nonEmpty(shape.constructorIdentity.unitId)) return "fnctor identity has an empty unit";
  if (!Number.isSafeInteger(shape.constructorIdentity.paramIndex) || shape.constructorIdentity.paramIndex < 0) {
    return "fnctor identity has an invalid parameter index";
  }
  const expectedIdentityIndex =
    shape.captures.reduce((count, capture) => count + (capture.hasTdzFlag ? 2 : 1), 0) + shape.userParamTypes.length;
  if (shape.constructorIdentity.paramIndex !== expectedIdentityIndex) {
    return `fnctor identity index ${shape.constructorIdentity.paramIndex} does not follow captures/user parameters ${expectedIdentityIndex}`;
  }
  return null;
}

/** Return a diagnostic when a shape is malformed; return null when valid. */
export function validateIrFnctorShape(shape: IrFnctorShape): string | null {
  return validateShapeGraph(shape, new Set<object>(), new Set<object>());
}

function fnctorRefEquals(a: IrFuncRef | IrTypeRef, b: IrFuncRef | IrTypeRef): boolean {
  return a.kind === b.kind && canonicalJson(a.binding) === canonicalJson(b.binding);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

function fieldsEqual(a: readonly IrFnctorField[], b: readonly IrFnctorField[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (field, index) =>
        field.name === b[index]!.name &&
        field.ordinal === b[index]!.ordinal &&
        irTypeEquals(field.type, b[index]!.type),
    )
  );
}

function capturesEqual(a: readonly IrFnctorCapture[], b: readonly IrFnctorCapture[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (capture, index) =>
        capture.name === b[index]!.name &&
        capture.ordinal === b[index]!.ordinal &&
        capture.hasTdzFlag === b[index]!.hasTdzFlag &&
        irTypeEquals(capture.type, b[index]!.type),
    )
  );
}

/** Exact nominal equality; labels and array order are ABI-significant. */
export function irFnctorShapeEquals(a: IrFnctorShape, b: IrFnctorShape): boolean {
  return (
    validateIrFnctorShape(a) === null &&
    validateIrFnctorShape(b) === null &&
    a.sourceId === b.sourceId &&
    a.constructorUnitId === b.constructorUnitId &&
    fnctorRefEquals(a.constructorTarget, b.constructorTarget) &&
    fnctorRefEquals(a.reservedLayout, b.reservedLayout) &&
    fieldsEqual(a.fields, b.fields) &&
    capturesEqual(a.captures, b.captures) &&
    a.userParamTypes.length === b.userParamTypes.length &&
    a.userParamTypes.every((type, index) => irTypeEquals(type, b.userParamTypes[index]!)) &&
    a.constructorIdentity.unitId === b.constructorIdentity.unitId &&
    a.constructorIdentity.paramIndex === b.constructorIdentity.paramIndex
  );
}

/** Validate a backend result without consulting ambient codegen context. */
export function validateIrFnctorResolution(resolution: IrFnctorResolution): string | null {
  const shapeError = validateIrFnctorShape(resolution.shape);
  if (shapeError) return shapeError;
  const resultLayoutError = validateRef(resolution.structType, "fnctor resolved struct");
  if (resultLayoutError) return resultLayoutError;
  if (!fnctorRefEquals(resolution.structType, resolution.shape.reservedLayout)) {
    return "fnctor resolved struct does not preserve the reserved layout identity";
  }
  const resultCtorError = validateRef(resolution.constructor, "fnctor resolved constructor");
  if (resultCtorError) return resultCtorError;
  if (!irFnctorShapeEquals(resolution.shape, { ...resolution.shape, constructorTarget: resolution.constructor })) {
    return "fnctor resolved constructor does not preserve the nominal target";
  }
  if (
    resolution.captureParamTypes.length !== resolution.shape.captures.reduce((n, c) => n + (c.hasTdzFlag ? 2 : 1), 0)
  ) {
    return "fnctor resolved capture ABI length does not match the shape";
  }
  if (resolution.userParamTypes.length !== resolution.shape.userParamTypes.length) {
    return "fnctor resolved user ABI length does not match the shape";
  }
  for (let i = 0; i < resolution.userParamTypes.length; i++) {
    if (!irTypeEquals(resolution.userParamTypes[i]!, resolution.shape.userParamTypes[i]!)) {
      return `fnctor resolved user parameter ${i} differs from the shape`;
    }
  }
  if (resolution.constructorIdentityParamIndex !== resolution.shape.constructorIdentity.paramIndex) {
    return "fnctor resolved identity parameter index differs from the shape";
  }
  return null;
}
