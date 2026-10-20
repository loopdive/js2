// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { PhysicalModuleReservations, FunctionReservation } from "../../../wasm/physical/module-reservations.js";
import type { NativeResourceRecipe } from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import type { NativeObjectRealmDeclarations } from "./native-object-realm.js";
import {
  requireNativePrimitivePrototypeIdentities,
  requireCompletedNativePrimitivePrototypeIdentities,
  type NativePrimitivePrototypeIdentities,
  type NativePrimitivePrototypeIdentityDependencies,
} from "./native-primitive-prototype-identities.js";
import {
  requireNativeNumberPrimitiveClassifierReservations,
  requireCompletedNativeNumberPrimitiveClassifier,
  type NativeNumberPrimitiveClassifierReservations,
  type NativeNumberPrimitiveClassifierDependencies,
} from "./native-number-primitive-classifier.js";
import {
  requireNativeErrorReservations,
  requireCompletedNativeErrors,
  type NativeErrorReservations,
  type NativeErrorRequirements,
  type NativeErrorDependencies,
} from "./native-errors.js";
import {
  NATIVE_PRIMITIVE_PROTOTYPE_IDENTITIES,
  type NativePrimitivePrototypeKind,
} from "../../../runtime/contracts/native-primitive-prototype-identities.js";
import {
  buildNativeToObjectUndefinedDefinition,
  buildNativeToObjectNullDefinition,
  buildNativeToObjectStringDefinition,
  buildNativeToObjectFactoryDefinition,
  buildNativeToObjectDefinition,
  type NativeToObjectFactoryOperands,
} from "../../../runtime/wasmgc/values/native-to-object-bodies.js";
import { buildUnboxNumberBody, buildUnboxNumberLocals } from "../../../runtime/wasmgc/values/number-bodies.js";
import { buildUnboxBooleanBody, buildUnboxBooleanLocals } from "../../../runtime/wasmgc/values/boolean-bodies.js";
import { buildUndefinedInitializer } from "../../../runtime/wasmgc/values/primitive-layouts.js";
import { buildErrorConstructorBody } from "../../../runtime/wasmgc/values/error-bodies.js";
import { planNativeStringLiteral } from "../../../runtime/wasmgc/values/string-literal-bodies.js";
import { requireNativeStringLiteral, nativeStringLiteralReservationInventory } from "./native-string-literals.js";
import {
  freezeNativeResourceRecipe,
  executeNativeResourceRecipe,
  requireNativeDeclaredReservation,
  instantiateNativeDeclaredSignature,
} from "./native-resource-declarations.js";

export interface NativeToObjectDependencies {
  readonly prototypes: NativePrimitivePrototypeIdentities;
  readonly prototypeDependencies: NativePrimitivePrototypeIdentityDependencies;
  readonly primitives: NativeNumberPrimitiveClassifierReservations;
  readonly primitivePlan: NativeResourceRecipe;
  readonly primitiveDependencies: NativeNumberPrimitiveClassifierDependencies;
  readonly errors: NativeErrorReservations;
  readonly errorRequirements: NativeErrorRequirements;
  readonly errorDependencies: NativeErrorDependencies;
}
/** Private admitted native ABI, NOT complete prototype members or source/public provider admission. */
export interface NativeToObjectKernel {
  readonly realm: NativeObjectRealmDeclarations;
  readonly toObject: FunctionReservation;
  readonly completionScope: "native-to-object-wrapping-kernel";
}
const roles = [
  "prototypes",
  "prototypeDependencies",
  "primitives",
  "primitivePlan",
  "primitiveDependencies",
  "errors",
  "errorRequirements",
  "errorDependencies",
] as const;
const functionRoles = [
  "is-undefined",
  "is-null",
  "is-string",
  ...NATIVE_PRIMITIVE_PROTOTYPE_IDENTITIES.map((row) => row.kind + ":create"),
  "run",
];
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly original: NativeToObjectDependencies;
  readonly dependencies: NativeToObjectDependencies;
  readonly functions: readonly FunctionReservation[];
  phase: "reserved" | "filling" | "complete" | "failed";
}
const owners = new WeakMap<NativeToObjectKernel, Owner>();
const realms = new WeakSet<NativeObjectRealmDeclarations>();
function fail(detail: string): never {
  throw Error("native ToObject kernel: " + detail);
}
function data(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || ![Object.prototype, null].includes(Object.getPrototypeOf(input)))
    fail("plain own-data dependencies required");
  const fields = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(fields).length !== keys.length) fail("unexpected dependency roles");
  for (const key of keys)
    if (
      !fields[key] ||
      !Object.hasOwn(fields[key]!, "value") ||
      !fields[key]!.enumerable ||
      fields[key]!.value === undefined
    )
      fail("own enumerable dependency data required");
  return Object.fromEntries(keys.map((key) => [key, fields[key]!.value]));
}
function dependencies(tx: PhysicalModuleReservations, input: NativeToObjectDependencies) {
  const d = data(input, roles) as unknown as NativeToObjectDependencies;
  data(d.errorRequirements, ["key"]);
  data(d.errorDependencies, ["strings", "typeErrorTag"]);
  requireNativePrimitivePrototypeIdentities(tx, d.prototypes, d.prototypeDependencies);
  requireNativeNumberPrimitiveClassifierReservations(tx, d.primitives, d.primitivePlan, d.primitiveDependencies);
  requireNativeErrorReservations(tx, d.errors, d.errorRequirements, d.errorDependencies);
  const p = d.primitiveDependencies,
    base = d.prototypeDependencies,
    m = base.mixedDependencies;
  if (
    p.values !== m.values ||
    p.valuePlan !== m.valuePlan ||
    p.valueDependencies !== m.valueDependencies ||
    p.strings !== base.wrapperDependencies.layoutDependencies.strings ||
    p.symbols !== base.wrapperDependencies.layoutDependencies.symbols ||
    d.errorDependencies.strings !== p.strings ||
    d.prototypes.realm !== m.realm
  )
    fail("different realm/value/primitive/error owners");
  return d;
}
function recipe(d: NativeToObjectDependencies): NativeResourceRecipe {
  const key = d.prototypes.realm.realm.description.key + ":to-object";
  const declarations = functionRoles.map((role, index) => ({
    key: key + ":" + role,
    role: ["native-to-object", role],
    space: "function" as const,
    name: "__native_to_object_" + role.replaceAll(":", "_"),
    signature: {
      params: [{ kind: "externref" as const }],
      results: [{ kind: index < 3 ? ("i32" as const) : ("externref" as const) }],
    },
  }));
  return freezeNativeResourceRecipe({
    declarations,
    reservationSteps: declarations.map((row) => ({ phase: "resources", kind: "reserve", resourceKey: row.key })),
  });
}
function current(tx: PhysicalModuleReservations, pack: NativeToObjectKernel): Owner {
  const o = owners.get(pack);
  if (!o || o.tx !== tx) fail("foreign or copied kernel owner");
  const d = dependencies(tx, o.original);
  if (roles.some((role) => d[role] !== o.dependencies[role])) fail("changed dependency identity");
  if (
    pack.realm !== d.prototypes.realm ||
    pack.toObject !== o.functions[8] ||
    pack.completionScope !== "native-to-object-wrapping-kernel"
  )
    fail("changed scope or issued token");
  const plan = recipe(d);
  o.functions.forEach((fn, index) => {
    const row = plan.declarations[index]!;
    if (row.space !== "function") fail("missing fixed declaration");
    const signature = instantiateNativeDeclaredSignature(tx, row.signature, new Map());
    if (
      fn.key !== row.key ||
      fn.object.name !== row.name ||
      fn.object.typeIdx !== tx.internFunctionType(signature.params, signature.results)
    )
      fail("changed fixed function declaration");
    if (tx.state !== "reserving") tx.physicalIndex(fn);
  });
  return o;
}
export function reserveNativeToObjectKernel(
  tx: PhysicalModuleReservations,
  input: NativeToObjectDependencies,
): NativeToObjectKernel {
  if (tx.state !== "reserving") fail("invalid reservation phase");
  const d = Object.freeze(dependencies(tx, input)),
    realm = d.prototypes.realm;
  if (realms.has(realm)) fail("realm already owns its ToObject kernel");
  const plan = recipe(d);
  tx.assertReservationKeysAvailable(plan.declarations.map((row) => row.key));
  const records = executeNativeResourceRecipe(tx, plan);
  const functions = Object.freeze(
    plan.declarations.map((row) => requireNativeDeclaredReservation(records, row.key, "function")),
  );
  const pack = Object.freeze({
    realm,
    toObject: functions[8]!,
    completionScope: "native-to-object-wrapping-kernel" as const,
  });
  owners.set(pack, { tx, original: input, dependencies: d, functions, phase: "reserved" });
  realms.add(realm);
  return pack;
}
export function requireNativeToObjectKernel(
  tx: PhysicalModuleReservations,
  pack: NativeToObjectKernel,
  expected: NativeToObjectDependencies,
): NativeToObjectKernel {
  if (current(tx, pack).original !== expected) fail("different expected dependency owner");
  return pack;
}
function errorLiteral(tx: PhysicalModuleReservations, d: NativeToObjectDependencies) {
  const strings = d.errorDependencies.strings,
    binding = requireNativeStringLiteral(tx, strings, "TypeError");
  const inventory = nativeStringLiteralReservationInventory(tx, strings);
  const request = inventory.requests.find((row) => row.binding === binding);
  const canonical = ([undefined, "ascii", "wtf16", "utf8-guaranteed"] as const)
    .map((encoding) => planNativeStringLiteral(strings.layout, inventory.typePack.utf8Storage, "TypeError", encoding))
    .find((plan) => plan.key === request?.cacheKey);
  if (binding.kind !== "global" || canonical?.kind !== "global") fail("missing canonical TypeError leaf");
  tx.assertCanonicalGlobalInitializer(binding.global, canonical.init);
  return binding.global;
}
function completedDependencies(tx: PhysicalModuleReservations, o: Owner) {
  const d = o.dependencies,
    p = d.primitiveDependencies,
    values = p.values;
  requireCompletedNativePrimitivePrototypeIdentities(tx, d.prototypes, d.prototypeDependencies);
  requireCompletedNativeNumberPrimitiveClassifier(tx, d.primitives, d.primitivePlan, p);
  requireCompletedNativeErrors(tx, d.errors, d.errorRequirements, d.errorDependencies);
  tx.assertCanonicalGlobalInitializer(
    values.globals.undefined,
    buildUndefinedInitializer(values.types.anyValue.typeIndex),
  );
  tx.assertCanonicalFunctionDefinition(p.booleans.unboxBoolean, {
    locals: buildUnboxBooleanLocals(),
    body: buildUnboxBooleanBody(values.types.boxedBoolean.typeIndex),
  });
  const strings = p.valueDependencies.strings;
  if (strings.kind !== "native-string") fail("missing native string conversion owner");
  tx.assertCanonicalFunctionDefinition(values.functions.unboxNumber, {
    locals: buildUnboxNumberLocals(),
    body: buildUnboxNumberBody(values.types.boxedNumber.typeIndex, values.types.boxedBoolean.typeIndex, {
      kind: "native-string",
      anyStringTypeIdx: strings.stringPack.layout.anyStrTypeIdx,
      toNumber: strings.scanner.toNumber.handle,
    }),
  });
  const name = errorLiteral(tx, d);
  tx.assertCanonicalFunctionDefinition(d.errors.newTypeError, {
    locals: [],
    body: buildErrorConstructorBody(d.errors.type.typeIndex, d.errorDependencies.typeErrorTag, 1, {
      kind: "global",
      index: tx.physicalIndex(name),
      representation: "gc",
    }),
  });
}
function definitions(tx: PhysicalModuleReservations, o: Owner) {
  const d = o.dependencies,
    base = d.prototypeDependencies,
    p = d.primitiveDependencies,
    f = o.functions;
  const factories = Object.fromEntries(
    NATIVE_PRIMITIVE_PROTOTYPE_IDENTITIES.map((row, index) => [row.kind, f[index + 3]!.handle]),
  ) as Record<NativePrimitivePrototypeKind, number>;
  const operands: NativeToObjectFactoryOperands = {
    prototypes: Object.fromEntries(
      NATIVE_PRIMITIVE_PROTOTYPE_IDENTITIES.map((row) => [row.kind, d.prototypes.read[row.kind].handle]),
    ) as Record<NativePrimitivePrototypeKind, number>,
    allocation: {
      ...Object.fromEntries(
        NATIVE_PRIMITIVE_PROTOTYPE_IDENTITIES.map((row) => [row.kind, base.wrappers.allocation[row.kind].handle]),
      ),
      String: base.stringCreate.create.handle,
    } as Record<NativePrimitivePrototypeKind, number>,
    unboxBoolean: p.booleans.unboxBoolean.handle,
    unboxNumber: p.values.functions.unboxNumber.handle,
    stringType: p.strings.layout.anyStrTypeIdx,
    symbolType: p.symbols.types.symbol.typeIndex,
  };
  const message = requireNativeStringLiteral(tx, p.strings, "TypeError");
  if (message.kind !== "global") fail("missing direct TypeError message");
  return [
    buildNativeToObjectUndefinedDefinition(
      p.values.types.anyValue.typeIndex,
      tx.physicalIndex(p.values.globals.undefined),
    ),
    buildNativeToObjectNullDefinition(),
    buildNativeToObjectStringDefinition(p.strings.layout.anyStrTypeIdx),
    ...NATIVE_PRIMITIVE_PROTOTYPE_IDENTITIES.map((row) => buildNativeToObjectFactoryDefinition(row.kind, operands)),
    buildNativeToObjectDefinition({
      undefinedType: p.values.types.anyValue.typeIndex,
      isPrimitive: d.primitives.isPrimitive.handle,
      classify: base.mixed.classify.handle,
      bindings: {
        isUndefined: f[0]!.handle,
        isNull: f[1]!.handle,
        isString: f[2]!.handle,
        isBoolean: p.booleans.isBoolean.handle,
        isNumber: p.values.functions.isNumber.handle,
        isSymbol: d.primitives.isSymbol.handle,
        isBigInt: p.bigints.isBigInt.handle,
        booleanCreate: factories.Boolean,
        numberCreate: factories.Number,
        stringCreate: factories.String,
        symbolCreate: factories.Symbol,
        bigintCreate: factories.BigInt,
        typeError: d.errors.newTypeError.handle,
        exceptionTag: tx.physicalIndex(d.prototypes.realm.exception.tag),
        errorMessage: [{ op: "global.get", index: tx.physicalIndex(message.global) }, { op: "extern.convert_any" }],
      },
    }),
  ];
}
export function fillNativeToObjectKernel(tx: PhysicalModuleReservations, pack: NativeToObjectKernel): void {
  const o = current(tx, pack);
  if (tx.state !== "filling" || o.phase !== "reserved") fail("invalid phase or duplicate/failed fill");
  completedDependencies(tx, o);
  const bodies = definitions(tx, o);
  o.phase = "filling";
  try {
    o.functions.forEach((fn, index) => tx.fillFunction(fn, bodies[index]!));
    o.phase = "complete";
  } catch (error) {
    o.phase = "failed";
    throw error;
  }
}
export function requireCompletedNativeToObjectKernel(
  tx: PhysicalModuleReservations,
  pack: NativeToObjectKernel,
  expected: NativeToObjectDependencies,
): NativeToObjectKernel {
  const o = current(tx, pack);
  if (o.original !== expected) fail("different expected dependency owner");
  if (o.phase !== "complete") fail("missing canonical wrapping-kernel fill");
  completedDependencies(tx, o);
  const bodies = definitions(tx, o);
  o.functions.forEach((fn, index) => tx.assertCanonicalFunctionDefinition(fn, bodies[index]!));
  return pack;
}
