// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { StructTypeDef } from "../../../wasm/model/module-records.js";
/** Exact mutable six-field builtin prototype metadata layout. */
export function buildNativePrototypeType(): StructTypeDef {
  return {
    kind: "struct",
    name: "__NativeProto",
    fields: [
      { name: "brand", type: { kind: "i32" }, mutable: true },
      { name: "isClass", type: { kind: "i32" }, mutable: true },
      { name: "ctor", type: { kind: "externref" }, mutable: true },
      { name: "parent", type: { kind: "externref" }, mutable: true },
      { name: "memberCsv", type: { kind: "externref" }, mutable: true },
      { name: "name", type: { kind: "externref" }, mutable: true },
    ],
  };
}
