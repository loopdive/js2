// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { ValType } from "../../../wasm/model/instructions.js";
import type { FieldDef, StructTypeDef } from "../../../wasm/model/module-records.js";
import { closureArityField, closureBagField } from "./closure-layouts.js";

export function createClosureCaptureHeader(): FieldDef[] {
  return [{ name: "func", type: { kind: "funcref" }, mutable: false }, closureArityField(), closureBagField()];
}

export function createClosureCaptureField(index: number, type: ValType): FieldDef {
  return { name: `cap${index}`, type, mutable: false };
}

export function createClosureCaptureType(
  name: string,
  superTypeIdx: number,
  captures: readonly ValType[],
): StructTypeDef {
  return {
    kind: "struct",
    name,
    superTypeIdx,
    fields: [...createClosureCaptureHeader(), ...captures.map((type, index) => createClosureCaptureField(index, type))],
  };
}
