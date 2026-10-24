// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../../../wasm/model/instructions.js";
import type { PhysicalModuleReservations } from "../../../wasm/physical/module-reservations.js";
import {
  reserveNativeInvocationCallable,
  nativeInvocationCallableBinding,
  nativeInvocationObjectRealmBinding,
  type NativeInvocationReservations,
} from "./native-invocation.js";
import type { NativeObjectRealmDeclarations } from "./native-object-realm.js";
import { requireNativeStringLiteral } from "./native-string-literals.js";
import { requireCanonicalNativeFunction } from "./native-resource-declarations.js";
import { buildBuiltinFunctionAlgorithmDefinition } from "../../../runtime/wasmgc/values/builtin-function-bodies.js";
import { buildFunctionPrototypeInvokerDefinition } from "../../../runtime/wasmgc/values/function-prototype-invoker-bodies.js";

const ids = ["%Function.prototype%", "%ThrowTypeError%", "%Function.prototype.call%"] as const;
export interface NativeRealmFunctionCore {
  readonly realm: NativeObjectRealmDeclarations;
  readonly implemented: typeof ids;
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly invocation: NativeInvocationReservations;
  filled: boolean;
}
const owners = new WeakMap<NativeRealmFunctionCore, Owner>();
const realms = new WeakSet<NativeObjectRealmDeclarations>();
function fail(message: string): never {
  throw Error("native realm Function core: " + message);
}
function ownerOf(tx: PhysicalModuleReservations, pack: NativeRealmFunctionCore) {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied owner");
  if (nativeInvocationObjectRealmBinding(tx, owner.invocation).realm !== pack.realm) fail("changed realm binding");
  return owner;
}
/** Own only these three algorithm slots; the remaining catalog never gains completion by count. */
export function reserveNativeRealmFunctionCore(
  tx: PhysicalModuleReservations,
  invocation: NativeInvocationReservations,
): NativeRealmFunctionCore {
  if (tx.state !== "reserving") fail("invalid reservation phase");
  const { realm } = nativeInvocationObjectRealmBinding(tx, invocation);
  if (realms.has(realm)) fail("realm already has a Function core owner");
  if (ids.some((id) => realm.entries.filter((entry) => entry.request.intrinsic.id === id).length !== 1))
    fail("missing canonical core entries");
  reserveNativeInvocationCallable(tx, invocation);
  const pack = Object.freeze({ realm, implemented: Object.freeze(ids) });
  owners.set(pack, { tx, invocation, filled: false });
  realms.add(realm);
  return pack;
}
function definitions(tx: PhysicalModuleReservations, pack: NativeRealmFunctionCore, completed: boolean) {
  const owner = ownerOf(tx, pack),
    d = nativeInvocationCallableBinding(tx, owner.invocation, completed);
  const message = requireNativeStringLiteral(tx, d.strings, "Value is not callable");
  const errorMessage: Instr[] = [
    message.kind === "global"
      ? { op: "global.get", index: tx.physicalIndex(message.global) }
      : { op: "call", funcIdx: message.function.handle },
    { op: "extern.convert_any" },
  ];
  const common = {
    undefinedGlobal: tx.physicalIndex(d.values.globals.undefined),
    errors: [errorMessage, errorMessage, errorMessage],
    typeError: d.errors.newTypeError.handle,
    exceptionTag: tx.physicalIndex(d.exception),
  };
  return ids.map((id) => ({
    token: pack.realm.entries.find((entry) => entry.request.intrinsic.id === id)!.algorithm,
    definition:
      id === "%Function.prototype.call%"
        ? buildFunctionPrototypeInvokerDefinition("call", {
            vector: d.arguments.layout,
            newVector: d.arguments.newVector.handle,
            push: d.arguments.push.handle,
            isCallable: d.isCallable.handle,
            undefinedValue: d.undefinedValue.handle,
            genericCall: d.call.handle,
            genericCallVector: "external",
            typeError: common.typeError,
            exceptionTag: common.exceptionTag,
            errorMessage,
          })
        : buildBuiltinFunctionAlgorithmDefinition(
            common,
            id === "%Function.prototype%" ? "function-prototype" : "throw-type-error",
          ),
  }));
}
export function fillNativeRealmFunctionCore(tx: PhysicalModuleReservations, pack: NativeRealmFunctionCore): void {
  const owner = ownerOf(tx, pack);
  if (tx.state !== "filling" || owner.filled) fail("invalid phase or duplicate fill");
  for (const row of definitions(tx, pack, true)) tx.fillFunction(row.token, row.definition);
  owner.filled = true;
}
export function requireCompletedNativeRealmFunctionCore(
  tx: PhysicalModuleReservations,
  pack: NativeRealmFunctionCore,
): NativeRealmFunctionCore {
  if (!ownerOf(tx, pack).filled) fail("missing canonical core fill");
  for (const row of definitions(tx, pack, true)) requireCanonicalNativeFunction(tx, row.token, row.definition);
  return pack;
}
