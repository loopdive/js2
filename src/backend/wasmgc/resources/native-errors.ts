// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type {
  PhysicalModuleReservations,
  TypeReservation,
  FunctionReservation,
} from "../../../wasm/physical/module-reservations.js";
import { createErrorStructType } from "../../../runtime/wasmgc/values/string-layouts.js";
import { buildErrorConstructorBody } from "../../../runtime/wasmgc/values/error-bodies.js";
import { requireNativeStringLiteral, type NativeStringLiteralReservations } from "./native-string-literals.js";

export interface NativeErrorDependencies {
  readonly strings: NativeStringLiteralReservations;
  /** Supplied from the existing tag authority; no second builtin catalog. */
  readonly typeErrorTag: number;
}
export interface NativeErrorReservations {
  readonly type: TypeReservation;
  readonly newTypeError: FunctionReservation;
}
const owners = new WeakMap<
  NativeErrorReservations,
  { tx: PhysicalModuleReservations; dependencies: NativeErrorDependencies; filled: boolean }
>();

export function reserveNativeErrorResources(
  tx: PhysicalModuleReservations,
  requirements: { readonly key: string },
  dependencies: NativeErrorDependencies,
): NativeErrorReservations {
  if (!requirements.key || tx.state !== "reserving") throw new Error("native errors: invalid reservation phase/key");
  // ABI invariant, not a replacement catalog. The parent supplies the canonical value.
  if (dependencies.typeErrorTag !== -11) throw new Error("native errors: incorrect TypeError tag");
  requireNativeStringLiteral(tx, dependencies.strings, "TypeError");
  const type = tx.reserveType(`${requirements.key}:type`, createErrorStructType());
  tx.internFunctionType([{ kind: "externref" }], [{ kind: "externref" }], "__new_TypeError_type");
  const newTypeError = tx.reserveFunction(`${requirements.key}:new-TypeError`, "__new_TypeError", {
    params: [{ kind: "externref" }],
    results: [{ kind: "externref" }],
  });
  const pack = Object.freeze({ type, newTypeError });
  owners.set(pack, { tx, dependencies: Object.freeze({ ...dependencies }), filled: false });
  return pack;
}

export function fillNativeErrorResources(tx: PhysicalModuleReservations, pack: NativeErrorReservations): void {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) throw new Error("native errors: foreign or forged resource owner");
  if (owner.filled) throw new Error("native errors: duplicate fill");
  tx.physicalIndex(pack.type);
  const name = requireNativeStringLiteral(tx, owner.dependencies.strings, "TypeError");
  tx.fillFunction(pack.newTypeError, {
    locals: [],
    body: buildErrorConstructorBody(
      pack.type.typeIndex,
      owner.dependencies.typeErrorTag,
      1,
      name.kind === "global"
        ? { kind: "global", index: tx.physicalIndex(name.global), representation: "gc" }
        : { kind: "callable", handle: name.function.handle, representation: "gc" },
    ),
  });
  owner.filled = true;
}
