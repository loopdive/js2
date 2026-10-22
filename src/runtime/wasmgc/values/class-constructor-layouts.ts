// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FuncHandle, Instr, LocalDef } from "../../../wasm/model/instructions.js";
import type { NativeDeclaredType } from "./native-resource-declaration-types.js";
import { CLOSURE_CAPTURE_FIELD_BASE, createSignatureWrapperShape } from "./closure-layouts.js";

export const CLASS_CONSTRUCT_CLOSURE_FIELD = CLOSURE_CAPTURE_FIELD_BASE;
export const CLASS_OBJECT_STATE_FIELD = CLASS_CONSTRUCT_CLOSURE_FIELD + 1;

export function createClassConstructorDeclaration(rootKey: string, stateKey: string): NativeDeclaredType {
  const root = createSignatureWrapperShape("$ClassConstructor", { kind: "resource" as const, typeKey: rootKey });
  return {
    ...root,
    final: true,
    fields: [
      ...root.fields,
      // Mutability separates this private reference from immutable source
      // captures; its reference type separates it from builtin integer metadata.
      { name: "[[ConstructClosure]]", type: { kind: "ref", typeKey: rootKey }, mutable: true },
      { name: "[[ObjectState]]", type: { kind: "ref", typeKey: stateKey }, mutable: false },
    ],
  };
}

/** Inputs: Call funcref, source arity, populated own bag, Construct closure, parent. */
export function buildClassConstructorAllocation(binding: {
  readonly classType: number;
  readonly closureRootType: number;
  readonly initializeState: FuncHandle;
}): { locals: LocalDef[]; body: Instr[] } {
  return {
    locals: [],
    body: [
      ...[0, 1, 2, 3].map((index) => ({ op: "local.get" as const, index })),
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: binding.closureRootType },
      { op: "local.get", index: 4 },
      { op: "call", funcIdx: binding.initializeState },
      { op: "struct.new", typeIdx: binding.classType },
      { op: "extern.convert_any" },
    ],
  };
}
