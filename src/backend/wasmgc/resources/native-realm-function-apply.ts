// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../../../wasm/model/instructions.js";
import type { FunctionReservation, PhysicalModuleReservations } from "../../../wasm/physical/module-reservations.js";
import {
  buildCreateListFromArrayLikeDefinition,
  ARRAY_LIKE_OBJECT_ERROR,
} from "../../../runtime/wasmgc/values/create-list-from-array-like-body.js";
import { buildFunctionPrototypeInvokerDefinition } from "../../../runtime/wasmgc/values/function-prototype-invoker-bodies.js";
import type { NativeInvocationReservations } from "./native-invocation.js";
import type { NativeObjectRealmDeclarations } from "./native-object-realm.js";
import { nativeRealmNumberCoercionBinding, type NativeRealmNumberCoercion } from "./native-realm-number-coercion.js";
import { nativeDecimalFormatBinding, type NativeDecimalFormat } from "./native-decimal-format.js";
import { requireNativeStringLiteral } from "./native-string-literals.js";
import { requireCanonicalNativeFunction } from "./native-resource-declarations.js";

const ids = ["%Function.prototype.apply%"] as const;
export interface NativeRealmFunctionApply {
  readonly realm: NativeObjectRealmDeclarations;
  readonly implemented: typeof ids;
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly invocation: NativeInvocationReservations;
  readonly coercion: NativeRealmNumberCoercion;
  readonly decimal: NativeDecimalFormat;
  readonly isObject: FunctionReservation;
  readonly isNull: FunctionReservation;
  readonly list: FunctionReservation;
  filled: boolean;
}
const owners = new WeakMap<NativeRealmFunctionApply, Owner>();
const realms = new WeakSet<NativeObjectRealmDeclarations>();
function fail(message: string): never {
  throw Error("native realm Function apply: " + message);
}
function current(tx: PhysicalModuleReservations, pack: NativeRealmFunctionApply): Owner {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied owner");
  return owner;
}
export function reserveNativeRealmFunctionApply(
  tx: PhysicalModuleReservations,
  key: string,
  invocation: NativeInvocationReservations,
  coercion: NativeRealmNumberCoercion,
  decimal: NativeDecimalFormat,
): NativeRealmFunctionApply {
  if (tx.state !== "reserving" || !key) fail("invalid reservation phase/key");
  const { call } = nativeRealmNumberCoercionBinding(tx, coercion, invocation);
  nativeDecimalFormatBinding(tx, decimal, call.strings);
  if (realms.has(call.realm)) fail("realm already has an apply owner");
  if (call.realm.entries.filter((row) => row.request.intrinsic.id === ids[0]).length !== 1)
    fail("missing canonical apply slot");
  for (const text of ["length", "Value is not callable", ARRAY_LIKE_OBJECT_ERROR])
    requireNativeStringLiteral(tx, call.strings, text);
  tx.assertReservationKeysAvailable(["object", "null", "list"].map((role) => key + ":" + role));
  const ext = { kind: "externref" } as const;
  const isObject = tx.reserveFunction(key + ":object", "__array_like_is_object", {
    params: [ext],
    results: [{ kind: "i32" }],
  });
  const isNull = tx.reserveFunction(key + ":null", "__array_like_is_null", {
    params: [ext],
    results: [{ kind: "i32" }],
  });
  const list = tx.reserveFunction(key + ":list", "__array_like_list", {
    params: [ext],
    results: [{ kind: "ref", typeIdx: call.arguments.layout.objVecTypeIdx }],
  });
  const pack = Object.freeze({ realm: call.realm, implemented: Object.freeze(ids) });
  owners.set(pack, { tx, invocation, coercion, decimal, isObject, isNull, list, filled: false });
  realms.add(call.realm);
  return pack;
}
function definitions(tx: PhysicalModuleReservations, pack: NativeRealmFunctionApply, owner: Owner) {
  const numeric = nativeRealmNumberCoercionBinding(tx, owner.coercion, owner.invocation, true),
    d = numeric.callable!;
  if (d.realm !== pack.realm) fail("changed realm owner");
  const decimal = nativeDecimalFormatBinding(tx, owner.decimal, d.strings, true);
  const literal = (text: string): Instr[] => {
    const value = requireNativeStringLiteral(tx, d.strings, text);
    return [
      value.kind === "global"
        ? { op: "global.get", index: tx.physicalIndex(value.global) }
        : { op: "call", funcIdx: value.function.handle },
      { op: "extern.convert_any" },
    ];
  };
  const common = {
    vector: d.arguments.layout,
    newVector: d.arguments.newVector.handle,
    push: d.arguments.push.handle,
    typeError: d.errors.newTypeError.handle,
    exceptionTag: tx.physicalIndex(d.exception),
  };
  return [
    {
      token: owner.isObject,
      definition: {
        locals: [],
        body: [
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: numeric.classifier.isPrimitive.handle },
          { op: "i32.eqz" },
        ] as Instr[],
      },
    },
    {
      token: owner.isNull,
      definition: { locals: [], body: [{ op: "local.get", index: 0 }, { op: "ref.is_null" }] as Instr[] },
    },
    {
      token: owner.list,
      definition: buildCreateListFromArrayLikeDefinition({
        ...common,
        isObject: owner.isObject.handle,
        get: numeric.get.handle,
        toLength: numeric.toLength.handle,
        indexToString: decimal.handle,
        lengthKey: literal("length"),
        errorMessage: literal(ARRAY_LIKE_OBJECT_ERROR),
      }),
    },
    {
      token: pack.realm.entries.find((row) => row.request.intrinsic.id === ids[0])!.algorithm,
      definition: buildFunctionPrototypeInvokerDefinition("apply", {
        ...common,
        isCallable: d.isCallable.handle,
        undefinedValue: d.undefinedValue.handle,
        isUndefined: d.isUndefined.handle,
        isNull: owner.isNull.handle,
        createListFromArrayLike: owner.list.handle,
        genericCall: d.call.handle,
        genericCallVector: "external",
        errorMessage: literal("Value is not callable"),
      }),
    },
  ];
}
export function fillNativeRealmFunctionApply(tx: PhysicalModuleReservations, pack: NativeRealmFunctionApply): void {
  const owner = current(tx, pack);
  if (tx.state !== "filling" || owner.filled) fail("invalid phase or duplicate fill");
  for (const row of definitions(tx, pack, owner)) tx.fillFunction(row.token, row.definition);
  owner.filled = true;
}
/** Supported array-like execution only; unsupported Get families retain their explicit trap. */
export function requireCompletedNativeRealmFunctionApply(
  tx: PhysicalModuleReservations,
  pack: NativeRealmFunctionApply,
): NativeRealmFunctionApply {
  const owner = current(tx, pack);
  if (!owner.filled) fail("missing canonical apply fill");
  for (const row of definitions(tx, pack, owner)) requireCanonicalNativeFunction(tx, row.token, row.definition);
  return pack;
}
