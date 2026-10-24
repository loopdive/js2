// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FunctionReservation, PhysicalModuleReservations } from "../../../wasm/physical/module-reservations.js";
import { buildCommonPromiseThenLookup } from "../../../runtime/wasmgc/promise/common-then-lookup-body.js";
import type { NativeInvocationReservations } from "./native-invocation.js";
import { nativeRealmNumberCoercionBinding, type NativeRealmNumberCoercion } from "./native-realm-number-coercion.js";
import { requireNativeStringLiteral } from "./native-string-literals.js";
import { requireCanonicalNativeFunction } from "./native-resource-declarations.js";

export interface NativePromiseThenLookup {
  readonly lookup: FunctionReservation;
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly invocation: NativeInvocationReservations;
  readonly coercion: NativeRealmNumberCoercion;
  filled: boolean;
}
const owners = new WeakMap<NativePromiseThenLookup, Owner>();
function fail(detail: string): never {
  throw Error("native Promise then lookup: " + detail);
}
function current(tx: PhysicalModuleReservations, pack: NativePromiseThenLookup) {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied owner");
  return owner;
}
function binding(owner: Owner, completed = false) {
  const result = nativeRealmNumberCoercionBinding(owner.tx, owner.coercion, owner.invocation, completed);
  const key = requireNativeStringLiteral(owner.tx, result.call.strings, "then");
  return { ...result, key };
}
/** Shares the existing scalar Get/primitive/Call producers; no raw semantic handles are accepted. */
export function reserveNativePromiseThenLookup(
  tx: PhysicalModuleReservations,
  key: string,
  invocation: NativeInvocationReservations,
  coercion: NativeRealmNumberCoercion,
): NativePromiseThenLookup {
  if (tx.state !== "reserving" || !key) fail("invalid reservation phase/key");
  const owner = { tx, invocation, coercion, filled: false };
  binding(owner);
  const ext = { kind: "externref" } as const;
  const pack = Object.freeze({
    lookup: tx.reserveFunction(key + ":lookup", "__promise_common_then", {
      params: [ext],
      results: [{ kind: "i32" }, ext],
    }),
  });
  owners.set(pack, owner);
  return pack;
}
function definition(owner: Owner, providers = binding(owner, true)) {
  const { get, classifier, callable, key } = providers;
  return buildCommonPromiseThenLookup(
    get.handle,
    classifier.isPrimitive.handle,
    callable!.isCallable.handle,
    callable!.undefinedValue.handle,
    [
      key.kind === "global"
        ? { op: "global.get", index: owner.tx.physicalIndex(key.global) }
        : { op: "call", funcIdx: key.function.handle },
      { op: "extern.convert_any" },
    ],
  );
}
export function fillNativePromiseThenLookup(tx: PhysicalModuleReservations, pack: NativePromiseThenLookup): void {
  const owner = current(tx, pack);
  if (tx.state !== "filling" || owner.filled) fail("invalid phase or duplicate fill");
  tx.fillFunction(pack.lookup, definition(owner));
  owner.filled = true;
}
/** Lookup completion alone grants no public Promise or whole-realm completion. */
export function nativePromiseThenLookupBinding(
  tx: PhysicalModuleReservations,
  pack: NativePromiseThenLookup,
  invocation: NativeInvocationReservations,
  completed = false,
) {
  const owner = current(tx, pack);
  if (owner.invocation !== invocation) fail("different invocation owner");
  const providers = binding(owner, completed);
  if (completed) {
    if (!owner.filled) fail("missing canonical lookup fill");
    requireCanonicalNativeFunction(tx, pack.lookup, definition(owner, providers));
  }
  return { ...providers, lookup: pack.lookup };
}
