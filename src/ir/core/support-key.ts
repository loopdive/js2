// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrClosureSignature, IrType } from "./types.js";
import { irTypeBindingKey } from "./type-binding-keys.js";
import { irCallableBindingKey } from "./callable-bindings.js";
import { orderedObjectFields } from "./object-layout.js";
import { ProgramAbiInvariantError } from "../../shared/contracts/program-abi-error.js";
import { canonicalProgramAbiValType } from "../../wasm/model/abi-value-key.js";

function canonicalClosureSupportIrType(type: IrType, active: Set<object>): unknown {
  if (active.has(type)) {
    throw new ProgramAbiInvariantError(
      "unknown-order-anchor",
      "closure support semantic type contains a recursive anonymous IR layout",
    );
  }
  active.add(type);
  try {
    switch (type.kind) {
      case "support-ref":
        if (type.ref?.kind !== "type" || type.ref.binding?.kind !== "support" || typeof type.nullable !== "boolean") {
          throw new ProgramAbiInvariantError(
            "type-remap-mismatch",
            "support-ref requires a support type reference and boolean nullability",
          );
        }
        try {
          return { kind: "support-ref", typeRef: irTypeBindingKey(type.ref.binding), nullable: type.nullable };
        } catch {
          throw new ProgramAbiInvariantError("type-remap-mismatch", "support-ref has an invalid support type binding");
        }
      case "val":
        if (type.typeRef) {
          if (type.val.kind !== "ref" && type.val.kind !== "ref_null") {
            throw new ProgramAbiInvariantError(
              "type-remap-mismatch",
              "symbolic physical type ref is attached to a scalar",
            );
          }
          return { kind: type.kind, value: { kind: type.val.kind, typeRef: irTypeBindingKey(type.typeRef.binding) } };
        }
        if (type.val.kind === "ref" || type.val.kind === "ref_null") {
          throw new ProgramAbiInvariantError(
            "unknown-order-anchor",
            "closure support semantic types cannot contain module-relative ref type indices",
          );
        }
        return {
          kind: type.kind,
          value: canonicalProgramAbiValType(type.val),
          ...(type.val.kind === "i32" ? { signed: type.signed ?? true } : {}),
        };
      case "string":
        return { kind: type.kind };
      case "vec":
        return {
          kind: type.kind,
          elementType: canonicalClosureSupportIrType(type.elementType, active),
          nullable: type.nullable,
        };
      case "object":
        return {
          kind: type.kind,
          allocationKind: type.shape.allocationKind,
          fields: orderedObjectFields(type.shape).map((field) => ({
            name: field.name,
            type: canonicalClosureSupportIrType(field.type, active),
            sourceMethodSignature: field.sourceMethodSignature,
          })),
        };
      case "closure":
      case "callable":
        return {
          kind: type.kind,
          signature: canonicalClosureSupportSignature(type.signature, active),
        };
      case "class":
        return { kind: type.kind, classId: type.shape.classId };
      case "extern":
        return { kind: type.kind, className: type.className };
      case "fnctor":
        return {
          kind: type.kind,
          sourceId: type.shape.sourceId,
          constructorUnitId: type.shape.constructorUnitId,
          constructorTarget: irCallableBindingKey(type.shape.constructorTarget.binding),
          reservedLayout: irTypeBindingKey(type.shape.reservedLayout.binding),
        };
      case "union":
        return {
          kind: type.kind,
          members: type.members.map((member) => canonicalClosureSupportIrType(member, active)),
        };
      case "boxed":
        return { kind: type.kind, inner: canonicalClosureSupportIrType(type.inner, active) };
      case "dynamic":
        return { kind: type.kind, tag: type.tag ?? null };
      default: {
        const exhaustive: never = type;
        throw new ProgramAbiInvariantError(
          "type-remap-mismatch",
          `unknown closure support IR type kind ${(exhaustive as { kind?: unknown }).kind ?? "<missing>"}`,
        );
      }
    }
  } finally {
    active.delete(type);
  }
}

function canonicalClosureSupportSignature(signature: IrClosureSignature, active = new Set<object>()): unknown {
  if (active.has(signature)) {
    throw new ProgramAbiInvariantError("unknown-order-anchor", "closure support contains a recursive IR signature");
  }
  active.add(signature);
  try {
    return {
      params: signature.params.map((type) => canonicalClosureSupportIrType(type, active)),
      returnType: signature.returnType === null ? null : canonicalClosureSupportIrType(signature.returnType, active),
    };
  } finally {
    active.delete(signature);
  }
}

/** Backend-neutral semantic key for one caller-visible closure signature. */
export function canonicalProgramAbiClosureSignatureKey(signature: IrClosureSignature): string {
  return JSON.stringify(canonicalClosureSupportSignature(signature));
}

/** Backend-neutral semantic key for one signature plus ordered capture layout. */
export function canonicalProgramAbiClosureLayoutKey(
  signature: IrClosureSignature,
  captureFieldTypes: readonly IrType[],
  domCallbackAuthorityKey?: string,
): string {
  const ordinary = {
    signature: canonicalClosureSupportSignature(signature),
    captures: captureFieldTypes.map((type) => canonicalClosureSupportIrType(type, new Set<object>())),
  };
  return JSON.stringify(
    domCallbackAuthorityKey === undefined ? ordinary : { ...ordinary, domCallbackAuthority: domCallbackAuthorityKey },
  );
}

/** Backend-neutral semantic key for one mutable-capture cell payload. */
export function canonicalProgramAbiRefCellKey(innerType: IrType): string {
  return JSON.stringify(canonicalClosureSupportIrType(innerType, new Set<object>()));
}

/** Backend-neutral semantic key for one closed IR object layout. */
export function canonicalProgramAbiObjectShapeKey(objectType: Extract<IrType, { readonly kind: "object" }>): string {
  return JSON.stringify(canonicalClosureSupportIrType(objectType, new Set<object>()));
}
