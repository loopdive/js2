// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrFuncRef, IrInstr, IrObjectShape, IrType, IrValueId } from "../core/nodes.js";
import { irTypeEquals } from "../core/types.js";
import type { IrObjectReferenceLowering } from "../backend/handles.js";
import type { IrLowerResolver } from "../backend/lower-contracts.js";
import type { BackendEmitter } from "../backend/emitter.js";

/** No native-layout fallback after a component has selected a reference ABI. */
export function resolveObjectReference(
  resolver: Pick<IrLowerResolver, "resolveObjectReference">,
  shape: IrObjectShape,
): IrObjectReferenceLowering | undefined {
  if (!resolver.resolveObjectReference) return undefined;
  const reference = resolver.resolveObjectReference(shape);
  if (!reference || reference.carrier.kind !== "externref")
    throw new Error("ir/lower: logical object has no declared reference carrier");
  return reference;
}

export function objectReferenceFieldProvider(
  reference: IrObjectReferenceLowering,
  shape: IrObjectShape,
  name: string,
  type: IrType | null,
  operation: "get" | "set",
  failureMode?: "throw" | "ignore",
): IrFuncRef {
  const field = shape.fields.find((row) => row.name === name);
  if (!field || !type || !irTypeEquals(field.type, type))
    throw new Error(`ir/lower: reference object ${operation} has a different logical field contract (${name})`);
  if (operation === "set" && failureMode !== "throw" && failureMode !== "ignore")
    throw new Error("ir/lower: reference object Set requires its source write mode");
  const role = operation === "set" && failureMode === "ignore" ? "setSloppy" : operation;
  const provider = reference.fields.get(name)?.[role];
  if (!provider) throw new Error(`ir/lower: reference object ${operation} has no declared provider (${name})`);
  return provider;
}

/** One logical object operation, with an explicit physical ABI decision. */
export function emitObjectOperation<S>(
  instruction: Extract<IrInstr, { kind: "object.new" | "object.get" | "object.set" }>,
  context: {
    readonly resolver: IrLowerResolver;
    readonly emitter: BackendEmitter<S>;
    readonly emitValue: (value: IrValueId, out: S) => void;
    readonly typeOf: (value: IrValueId) => IrType;
    readonly funcName: string;
    readonly describeShape: (shape: IrObjectShape) => string;
  },
  out: S,
): void {
  const { resolver, emitter, emitValue, typeOf, funcName, describeShape } = context;
  const type =
    instruction.kind === "object.new"
      ? { kind: "object" as const, shape: instruction.shape }
      : typeOf(instruction.value);
  if (type.kind !== "object")
    throw new Error(`ir/lower: ${instruction.kind} value must be an object IrType, got ${type.kind} (${funcName})`);
  const shape = instruction.kind === "object.new" ? instruction.shape : type.shape;
  const reference = resolveObjectReference(resolver, shape);
  if (instruction.kind !== "object.new" && reference) {
    throw new Error("ir/lower: reference property operations must be projected before optimization");
  }
  const object = resolver.resolveObject?.(shape, instruction.kind === "object.new" ? instruction.alloc : undefined);
  if (!object) throw new Error(`ir/lower: resolver cannot lower object<${describeShape(shape)}> (${funcName})`);
  if (instruction.kind === "object.new") {
    // Canonical sorted field order, identical to native-only construction.
    // Erase the newly allocated native reference once; never wrap/copy inputs.
    for (const value of instruction.values) emitValue(value, out);
    emitter.emitAggregateNew(object, instruction.values.length, out);
    if (reference) emitter.emitToExternref(out);
  } else {
    emitValue(instruction.value, out);
    if (instruction.kind === "object.get") emitter.emitFieldGet(object, instruction.name, out);
    else {
      emitValue(instruction.newValue, out);
      emitter.emitFieldSet(object, instruction.name, out);
    }
  }
}
