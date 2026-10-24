// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../../../wasm/model/instructions.js";
import type { FunctionReservation, PhysicalModuleReservations } from "../../../wasm/physical/module-reservations.js";
import {
  buildToNumberDefinition,
  NUMBER_CONVERSION_LITERALS,
} from "../../../runtime/wasmgc/values/number-from-value-body.js";
import { buildMixedObjectScalarGetDefinition } from "../../../runtime/wasmgc/values/mixed-object-scalar-get-body.js";
import { buildToLengthDefinition } from "../../../runtime/wasmgc/values/to-length-body.js";
import { buildArgumentVectorMethodAdapter } from "../../../runtime/wasmgc/values/argument-vector-call-adapters.js";
import {
  nativeInvocationCallableBinding,
  nativeInvocationObjectRealmBinding,
  reserveNativeInvocationCallable,
  type NativeInvocationReservations,
} from "./native-invocation.js";
import { nativeMixedObjectGetBinding, type NativeMixedObjectAccessReservations } from "./native-mixed-object-access.js";
import {
  nativeNumberPrimitiveClassifierBinding,
  type NativeNumberPrimitiveClassifierReservations,
} from "./native-number-primitive-classifier.js";
import { requireNativeStringLiteral } from "./native-string-literals.js";
import { requireCanonicalNativeFunction } from "./native-resource-declarations.js";
import {
  declareNativeWellKnownSymbolResources,
  reserveNativeWellKnownSymbolResources,
  fillNativeWellKnownSymbolResources,
  requireCompletedNativeWellKnownSymbols,
  nativeWellKnownSymbolProducer,
} from "./native-well-known-symbols.js";

export interface NativeRealmNumberCoercion {
  readonly toNumber: FunctionReservation;
  readonly toLength: FunctionReservation;
}
interface Dependencies {
  readonly invocation: NativeInvocationReservations;
  readonly access: NativeMixedObjectAccessReservations;
  readonly classifier: NativeNumberPrimitiveClassifierReservations;
}
interface Owner extends Dependencies {
  readonly tx: PhysicalModuleReservations;
  readonly methods: readonly FunctionReservation[];
  readonly scalarGet: FunctionReservation;
  readonly symbols: ReturnType<typeof reserveNativeWellKnownSymbolResources>;
  readonly symbolPlan: ReturnType<typeof declareNativeWellKnownSymbolResources>;
  readonly symbolDependencies: Parameters<typeof reserveNativeWellKnownSymbolResources>[4];
  filled: boolean;
}
const owners = new WeakMap<NativeRealmNumberCoercion, Owner>();
function fail(message: string): never {
  throw Error("native realm number coercion: " + message);
}
function bindings(tx: PhysicalModuleReservations, owner: Dependencies, completed = false) {
  const call = nativeInvocationObjectRealmBinding(tx, owner.invocation);
  const callable = completed ? nativeInvocationCallableBinding(tx, owner.invocation, true) : undefined;
  const get = nativeMixedObjectGetBinding(tx, owner.access, owner.invocation, completed);
  const primitive = nativeNumberPrimitiveClassifierBinding(tx, owner.classifier, completed);
  if (
    primitive.values !== call.values ||
    primitive.booleans !== call.booleans ||
    primitive.strings !== call.strings ||
    primitive.symbols !== get.symbols
  )
    fail("different shared primitive/Get/Call producers");
  for (const text of Object.values(NUMBER_CONVERSION_LITERALS)) requireNativeStringLiteral(tx, call.strings, text);
  return { call, get, primitive, callable };
}
function current(tx: PhysicalModuleReservations, pack: NativeRealmNumberCoercion) {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied owner");
  return owner;
}
/** Real primitive conversion, mixed Get and generic Call; no caller-provided semantic handles. */
export function reserveNativeRealmNumberCoercion(
  tx: PhysicalModuleReservations,
  key: string,
  invocation: NativeInvocationReservations,
  access: NativeMixedObjectAccessReservations,
  classifier: NativeNumberPrimitiveClassifierReservations,
): NativeRealmNumberCoercion {
  if (tx.state !== "reserving" || !key) fail("invalid reservation phase/key");
  const dependencies = { invocation, access, classifier };
  const { primitive } = bindings(tx, dependencies);
  const symbolKey = key + ":symbols";
  const symbolPlan = declareNativeWellKnownSymbolResources(symbolKey, ["toPrimitive"]);
  tx.assertReservationKeysAvailable([
    ...symbolPlan.declarations.map((row) => row.key),
    ...["method0", "method1", "get", "number", "length"].map((role) => key + ":" + role),
  ]);
  reserveNativeInvocationCallable(tx, invocation);
  const symbolDependencies = Object.freeze({ symbols: primitive.symbols, strings: primitive.strings });
  const symbol = reserveNativeWellKnownSymbolResources(tx, symbolKey, ["toPrimitive"], symbolPlan, symbolDependencies);
  const ext = { kind: "externref" } as const,
    f64 = { kind: "f64" } as const;
  const methods = Object.freeze(
    [0, 1].map((arity) =>
      tx.reserveFunction(key + ":method" + arity, "__number_method" + arity, {
        params: Array.from({ length: arity + 2 }, () => ext),
        results: [ext],
      }),
    ),
  );
  const scalarGet = tx.reserveFunction(key + ":get", "__number_scalar_get", {
    params: [ext, ext, ext],
    results: [ext],
  });
  const pack = Object.freeze({
    toNumber: tx.reserveFunction(key + ":number", "__realm_to_number", { params: [ext], results: [f64] }),
    toLength: tx.reserveFunction(key + ":length", "__realm_to_length", { params: [ext], results: [f64] }),
  });
  owners.set(pack, {
    ...dependencies,
    tx,
    methods,
    scalarGet,
    symbols: symbol,
    symbolPlan,
    symbolDependencies,
    filled: false,
  });
  return pack;
}
function definitions(
  tx: PhysicalModuleReservations,
  pack: NativeRealmNumberCoercion,
  owner: Owner,
  binding: ReturnType<typeof bindings>,
) {
  const { call, get, primitive, callable } = binding;
  const symbol = nativeWellKnownSymbolProducer(
    tx,
    owner.symbols,
    "toPrimitive",
    owner.symbolPlan,
    owner.symbolDependencies,
  );
  requireCompletedNativeWellKnownSymbols(tx, owner.symbols, owner.symbolPlan, owner.symbolDependencies);
  const literal = (text: string): Instr[] => {
    const value = requireNativeStringLiteral(tx, call.strings, text);
    return [
      value.kind === "global"
        ? { op: "global.get", index: tx.physicalIndex(value.global) }
        : { op: "call", funcIdx: value.function.handle },
      { op: "extern.convert_any" },
    ];
  };
  const texts = NUMBER_CONVERSION_LITERALS;
  const number = buildToNumberDefinition({
    get: owner.scalarGet.handle,
    isPrimitive: owner.classifier.isPrimitive.handle,
    isCallable: callable!.isCallable.handle,
    isNullish: owner.classifier.isNullish.handle,
    isSymbol: owner.classifier.isSymbol.handle,
    isBigInt: primitive.bigints.isBigInt.handle,
    method0: owner.methods[0]!.handle,
    method1: owner.methods[1]!.handle,
    primitiveToNumber: primitive.values.functions.unboxNumber.handle,
    typeError: call.errors.newTypeError.handle,
    exceptionTag: tx.physicalIndex(call.exception),
    operands: {
      toPrimitiveSymbol: [{ op: "call", funcIdx: symbol.handle }],
      numberHint: literal(texts.numberHint),
      valueOfKey: literal(texts.valueOfKey),
      toStringKey: literal(texts.toStringKey),
      nonCallableError: literal(texts.nonCallableError),
      nonPrimitiveError: literal(texts.nonPrimitiveError),
      symbolError: literal(texts.symbolError),
      bigintError: literal(texts.bigintError),
    },
  });
  const adapter = {
    newVector: call.arguments.newVector.handle,
    push: call.arguments.push.handle,
    call: call.call.handle,
  };
  return [
    ...owner.methods.map((token, arity) => ({
      token,
      definition: buildArgumentVectorMethodAdapter(arity, adapter, "receiver-first"),
    })),
    { token: owner.scalarGet, definition: buildMixedObjectScalarGetDefinition(get.get.handle) },
    { token: pack.toNumber, definition: number },
    { token: pack.toLength, definition: buildToLengthDefinition(pack.toNumber.handle) },
  ];
}
export function fillNativeRealmNumberCoercion(tx: PhysicalModuleReservations, pack: NativeRealmNumberCoercion): void {
  const owner = current(tx, pack);
  if (tx.state !== "filling" || owner.filled) fail("invalid phase or duplicate fill");
  const binding = bindings(tx, owner, true);
  fillNativeWellKnownSymbolResources(tx, owner.symbols);
  for (const row of definitions(tx, pack, owner, binding)) tx.fillFunction(row.token, row.definition);
  owner.filled = true;
}
/** Exact Get/ToLength producers shared by array-like conversion and numeric coercion. */
export function nativeRealmNumberCoercionBinding(
  tx: PhysicalModuleReservations,
  pack: NativeRealmNumberCoercion,
  invocation: NativeInvocationReservations,
  completed = false,
) {
  const owner = current(tx, pack);
  if (owner.invocation !== invocation) fail("different invocation owner");
  const binding = bindings(tx, owner, completed);
  if (completed) {
    if (!owner.filled) fail("missing canonical numeric fill");
    for (const row of definitions(tx, pack, owner, binding))
      requireCanonicalNativeFunction(tx, row.token, row.definition);
  }
  return { ...binding, get: owner.scalarGet, classifier: owner.classifier, toLength: pack.toLength };
}
/** Narrow cycle completion only: the shared realm may still contain unfinished algorithms. */
export function requireCompletedNativeRealmNumberCoercion(
  tx: PhysicalModuleReservations,
  pack: NativeRealmNumberCoercion,
): void {
  const owner = current(tx, pack);
  if (!owner.filled) fail("missing canonical numeric fill");
  nativeRealmNumberCoercionBinding(tx, pack, owner.invocation, true);
}
