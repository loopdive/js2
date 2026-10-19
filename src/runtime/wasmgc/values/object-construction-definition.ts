// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FuncHandle, Instr, LocalDef } from "../../../wasm/model/instructions.js";
import { ORDINARY_OBJECT_DESCRIPTOR_ENCODING as flags } from "./ordinary-object-descriptor-common.js";

/** Compose existing ordinary Create/DefineData operations; this is not a second property engine. */
export function buildNativeObjectConstructionDefinition(bindings: {
  readonly create: FuncHandle;
  readonly defineData: FuncHandle;
  readonly parameterCount: number;
  readonly fields: readonly {
    readonly argument: number;
    readonly key: readonly Instr[];
    readonly conversion: readonly Instr[];
  }[];
}): { locals: LocalDef[]; body: Instr[] } {
  const result = bindings.parameterCount;
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: bindings.create },
    { op: "local.set", index: result },
  ];
  const descriptorMask =
    flags.writable |
    flags.enumerable |
    flags.configurable |
    flags.writableSpecified |
    flags.enumerableSpecified |
    flags.configurableSpecified |
    flags.hasValue;
  for (const field of bindings.fields) {
    body.push(
      { op: "local.get", index: result },
      ...field.key,
      {
        op: "local.get",
        index: field.argument,
      },
      ...field.conversion,
    );
    body.push({ op: "f64.const", value: descriptorMask }, { op: "call", funcIdx: bindings.defineData });
  }
  body.push({ op: "local.get", index: result });
  return { locals: [{ name: "$constructed", type: { kind: "externref" } }], body };
}
