// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrFunction, IrObjectShape } from "../core/nodes.js";
import type { IrObjectReferenceLowering } from "../backend/handles.js";
import { objectReferenceFieldProvider, resolveObjectReference } from "./object-reference.js";
import { projectObjectPropertyCalls } from "../program/object-property-projection.js";

/** Compatibility adapter from the explicit backend layout to the pure logical pass. */
export function projectObjectReferenceFunction(
  fn: IrFunction,
  resolve: (shape: IrObjectShape) => IrObjectReferenceLowering | null,
): IrFunction {
  return projectObjectPropertyCalls(fn, (shape, name, fieldType, operation, failureMode) => {
    const reference = resolveObjectReference({ resolveObjectReference: resolve }, shape)!;
    return objectReferenceFieldProvider(reference, shape, name, fieldType, operation, failureMode);
  });
}
