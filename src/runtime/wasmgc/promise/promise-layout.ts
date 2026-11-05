// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { ValType } from "../../../wasm/model/instructions.js";

/** Canonical native Promise carrier shared by declarations and frame construction. */
export function createNativePromiseShape() {
  const i32 = { kind: "i32" } as const;
  const extern = { kind: "externref" } as const;
  return {
    kind: "struct" as const,
    name: "$Promise",
    fields: [
      { name: "state", type: i32, mutable: true },
      { name: "value", type: extern, mutable: true },
      { name: "callbacks", type: extern, mutable: true },
      { name: "$bag", type: extern, mutable: true },
      { name: "$handled", type: i32, mutable: true },
    ],
  };
}

/** Validate the positional ABI before publishing any frame functions. */
export function assertNativePromiseShape(shape: {
  readonly fields: readonly { readonly type: ValType; readonly mutable: boolean }[];
}): void {
  const expected = createNativePromiseShape().fields;
  if (
    shape.fields.length !== expected.length ||
    expected.some(
      (field, index) =>
        shape.fields[index]?.type.kind !== field.type.kind || shape.fields[index]?.mutable !== field.mutable,
    )
  )
    throw new Error("prepared frame has the wrong native Promise layout");
}
