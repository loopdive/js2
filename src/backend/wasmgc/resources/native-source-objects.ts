// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O1) The public source-callable functions on the realm. A source program reaches an ordinary object only
 * through the `js.object.*` contracts (`ordinary-object-callables.ts`), and (#7354 C) a function object through the
 * `js.function.*` contracts (`function-object-callables.ts`); each contract it calls binds one function here, whose
 * signature is the contract's and whose algorithm is the realm's own. A row either
 *   - adapts the realm: a function this module reserves, with the contract's signature and a body
 *     (`source-object-bodies.ts`, `source-function-object-bodies.ts`) over the storage pack, the builtin-object kernel
 *     and the closure invocation; or
 *   - binds a realm function as it is (`define-data`: the descriptor pack's public define; (#7354 O4)
 *     `create-type-error`: the invocation substrate's TypeError constructor).
 * A contract without a row here has no native source provider yet.
 */
import type { FunctionReservation, PhysicalModuleReservations } from "../../../wasm/physical/module-reservations.js";
import type { Instr, ValType } from "../../../wasm/model/instructions.js";
import type { RealmSourceCallFeature } from "../../../ir/program/native-realm-requirements.js";
import { arityCallableArity } from "../../../ir/core/closure-invocation-callables.js";
import { FUNCTION_OBJECT_INIT_FLAGS } from "../../../ir/runtime/function-object-callables.js";
import type { BuiltinFunctionPrototypeOperands } from "../../../runtime/wasmgc/values/builtin-function-prototype-bodies.js";
import {
  buildSourceObjectCreateDefinition,
  buildSourceObjectGetDefinition,
  type SourceObjectCreateOperands,
  type SourceObjectDefinition,
} from "../../../runtime/wasmgc/values/source-object-bodies.js";
import {
  buildSourceFunctionConstructDefinition,
  buildSourceFunctionHasInstanceDefinition,
  buildSourceFunctionInitDefinition,
  buildSourceFunctionIsCallableDefinition,
  buildSourceFunctionThisDefinition,
} from "../../../runtime/wasmgc/values/source-function-object-bodies.js";
import { nativeBuiltinFunctionOperands, type NativeBuiltinFunctionReservations } from "./native-builtin-functions.js";
import { nativeBuiltinFunctionRequestDependencies } from "./native-builtin-function-requests.js";
import type { NativeErrorReservations } from "./native-errors.js";
import type { NativeInvocationReservations } from "./native-invocation.js";
import type { NativeObjectDescriptorReservations } from "./native-object-descriptors.js";
import type { NativeObjectLayoutReservations } from "./native-object-layouts.js";
import type { NativeObjectStorageReservations } from "./native-object-storage.js";
import { nativeStringLiteralInstrs, type NativeStringLiteralReservations } from "./native-string-literals.js";

export interface NativeSourceObjectDependencies {
  readonly layouts: NativeObjectLayoutReservations;
  readonly storage: NativeObjectStorageReservations;
  readonly descriptors: NativeObjectDescriptorReservations;
  readonly kernel: NativeBuiltinFunctionReservations;
  readonly errors: NativeErrorReservations;
  /** The closure invocation of a realm with source closures; `this` and `construct` dispatch through it. */
  readonly invocation?: NativeInvocationReservations;
}
const EXTERNREF = { kind: "externref" } as const,
  I32 = { kind: "i32" } as const,
  F64 = { kind: "f64" } as const;
/** The strings the function-object adapters use; the realm's literal plan must carry them. */
const TEXT = Object.freeze({
  prototype: "prototype",
  constructor: "constructor",
  notCallable: "Value is not callable",
  notConstructor: "TypeError: function is not a constructor",
  functionPrototype: "TypeError: new with a function-valued prototype needs a function [[Prototype]] link",
  nonObjectPrototype: "TypeError: instanceof needs an object prototype",
  unboundSloppy: "TypeError: unbound sloppy this needs js.object.global (#7350 B2b)",
  primitiveSloppy: "TypeError: sloppy this of a primitive needs ToObject",
});
export const NATIVE_SOURCE_FUNCTION_LITERALS: readonly string[] = Object.freeze(Object.values(TEXT));

/** What an adapter body reads at fill time: its dependencies, the kernel's operands and the realm's literals. */
interface AdapterContext extends NativeSourceObjectDependencies {
  readonly tx: PhysicalModuleReservations;
  readonly operands: BuiltinFunctionPrototypeOperands;
  /** The externref of one of {@link TEXT}'s strings. */
  readonly text: (key: keyof typeof TEXT) => Instr[];
}
/**
 * An adapter (the contract signature it reserves, its body over the realm's packs) or a bound realm function. A
 * member `<feature>:N` of an arity family (`js.function.construct:N`) takes N more externref operands after the
 * signature's, and its body is built for that N; every other contract has arity 0.
 */
type Row =
  | {
      readonly signature: { readonly params: readonly ValType[]; readonly results: readonly ValType[] };
      readonly body: (context: AdapterContext, arity: number) => SourceObjectDefinition;
    }
  | { readonly binds: (dependencies: NativeSourceObjectDependencies) => FunctionReservation };
function fail(detail: string): never {
  throw new Error("native source objects: " + detail);
}
const create = ({ layouts, storage, kernel }: NativeSourceObjectDependencies): SourceObjectCreateOperands => ({
  objectTypeIdx: layouts.object.typeIndex,
  objectPrototype: kernel.functions.objectPrototype.handle,
  createWithPrototype: storage.createWithPrototype.handle,
});
/**
 * The contracts whose adapter runs inside the closure invocation, which only a realm with source closures reserves:
 * `construct:N` calls `js.closure.call:N`, `this` reads the receiver the dispatcher installs.
 */
export const NATIVE_SOURCE_OBJECT_INVOCATION_FEATURES: ReadonlySet<string> = new Set([
  "js.function.construct",
  "js.function.this",
]);
function invocation(context: AdapterContext): NativeInvocationReservations {
  return context.invocation ?? fail("a function-object adapter needs the realm's closure invocation");
}
/** The contracts the realm serves. A new realm-served contract is one row. */
const ROWS = {
  "js.object.create-default": {
    signature: { params: [], results: [EXTERNREF] },
    body: (context) => buildSourceObjectCreateDefinition(create(context)),
  },
  "js.object.define-data": { binds: ({ descriptors }) => descriptors.defineData },
  "js.object.create-type-error": { binds: ({ errors }) => errors.newTypeError },
  "js.object.get": {
    signature: { params: [EXTERNREF, EXTERNREF, EXTERNREF], results: [EXTERNREF] },
    body: ({ kernel }) => buildSourceObjectGetDefinition({ get: kernel.functions.get.handle }),
  },
  "js.function.is-callable": {
    signature: { params: [EXTERNREF], results: [I32] },
    body: ({ operands }) => buildSourceFunctionIsCallableDefinition(operands),
  },
  "js.function.init": {
    signature: { params: [EXTERNREF, EXTERNREF, F64, F64], results: [] },
    body: (context) =>
      buildSourceFunctionInitDefinition({
        kernel: context.operands,
        create: create(context),
        prototypeKey: context.text("prototype"),
        constructorKey: context.text("constructor"),
        constructible: FUNCTION_OBJECT_INIT_FLAGS.constructible,
      }),
  },
  "js.function.construct": {
    signature: { params: [EXTERNREF], results: [EXTERNREF] },
    body: (context, arity) =>
      buildSourceFunctionConstructDefinition(
        {
          kernel: context.operands,
          get: context.kernel.functions.get.handle,
          create: create(context),
          call:
            invocation(context).methods.find((row) => row.arity === arity)?.function.handle ??
            fail(`js.function.construct:${arity} needs the invocation's js.closure.call:${arity}`),
          prototypeKey: context.text("prototype"),
          notConstructor: context.text("notConstructor"),
          functionPrototype: context.text("functionPrototype"),
        },
        arity,
      ),
  },
  "js.function.has-instance": {
    signature: { params: [EXTERNREF, EXTERNREF], results: [I32] },
    body: (context) =>
      buildSourceFunctionHasInstanceDefinition({
        kernel: context.operands,
        get: context.kernel.functions.get.handle,
        prototypeKey: context.text("prototype"),
        notCallable: context.text("notCallable"),
        nonObjectPrototype: context.text("nonObjectPrototype"),
      }),
  },
  "js.function.this": {
    signature: { params: [I32], results: [EXTERNREF] },
    body: (context) =>
      buildSourceFunctionThisDefinition({
        kernel: context.operands,
        currentThis: context.tx.physicalIndex(invocation(context).globals.currentThis),
        isUndefined: invocation(context).isUndefined.handle,
        unboundSloppy: context.text("unboundSloppy"),
        primitiveSloppy: context.text("primitiveSloppy"),
      }),
  },
} as const satisfies Readonly<Partial<Record<RealmSourceCallFeature, Row>>>;
/** A contract the realm serves. */
export type NativeSourceObjectFeature = keyof typeof ROWS;
/** A called contract: its feature, and the symbol its call rows name (`<feature>` or `<feature>:N`). */
export interface NativeSourceObjectCall {
  readonly feature: RealmSourceCallFeature;
  readonly symbol: string;
}

/** The function serving one called symbol, under the key its call rows bind. */
export interface NativeSourceObjectFunction {
  readonly feature: NativeSourceObjectFeature;
  readonly arity: number;
  readonly key: string;
  readonly token: FunctionReservation;
}
/** The row, operand count and key serving `call` in the realm keyed `realmKey`, or `undefined` when none serves it. */
function served(realmKey: string, { feature, symbol }: NativeSourceObjectCall) {
  if (!Object.hasOwn(ROWS, feature)) return undefined;
  const arity = symbol === feature ? 0 : arityCallableArity(feature + ":", symbol);
  if (arity === undefined) fail(`${symbol} is not a canonical symbol of ${feature}`);
  return { feature: feature as NativeSourceObjectFeature, arity, key: realmKey + ":source-objects:" + symbol };
}

/**
 * The key the program's call rows bind for `call` in the realm keyed `realmKey`, or `undefined` when the contract has
 * no native source provider.
 */
export function nativeSourceObjectResourceKey(realmKey: string, call: NativeSourceObjectCall): string | undefined {
  return served(realmKey, call)?.key;
}

export interface NativeSourceObjectReservations {
  /** One row per symbol the program calls (`js.function.construct:N` per arity), in symbol order. */
  readonly served: readonly NativeSourceObjectFunction[];
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly dependencies: NativeSourceObjectDependencies;
  readonly identities: NativeSourceObjectDependencies;
  filled: boolean;
}
const owners = new WeakMap<NativeSourceObjectReservations, Owner>();
function requireOwner(tx: PhysicalModuleReservations, pack: NativeSourceObjectReservations): Owner {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied owner");
  for (const key of Object.keys(owner.identities) as (keyof NativeSourceObjectDependencies)[])
    if (owner.dependencies[key] !== owner.identities[key]) fail("substituted dependency identity");
  return owner;
}

/** A function per served symbol the program calls: an adapter reserved here, or the realm function a row binds. */
export function reserveNativeSourceObjectResources(
  tx: PhysicalModuleReservations,
  realmKey: string,
  calls: readonly NativeSourceObjectCall[],
  dependencies: NativeSourceObjectDependencies,
): NativeSourceObjectReservations {
  const bySymbol = new Map(calls.map((call) => [call.symbol, call]));
  const rows = [...bySymbol.keys()].sort().flatMap((symbol) => {
    const call = served(realmKey, bySymbol.get(symbol)!);
    if (!call) return [];
    const row: Row = ROWS[call.feature];
    const token =
      "binds" in row
        ? row.binds(dependencies)
        : tx.reserveFunction(call.key, call.key, {
            params: [...row.signature.params, ...Array<ValType>(call.arity).fill(EXTERNREF)],
            results: [...row.signature.results],
          });
    return [Object.freeze({ ...call, token })];
  });
  const pack = Object.freeze({ served: Object.freeze(rows) });
  owners.set(pack, { tx, dependencies, identities: Object.freeze({ ...dependencies }), filled: false });
  return pack;
}

/** The functions this pack owns: its adapters. A bound function stays in its producer's inventory. */
export function nativeSourceObjectReservationInventory(
  tx: PhysicalModuleReservations,
  pack: NativeSourceObjectReservations,
): readonly FunctionReservation[] {
  requireOwner(tx, pack);
  return pack.served.filter((row) => "body" in ROWS[row.feature]).map((row) => row.token);
}

export function fillNativeSourceObjectResources(
  tx: PhysicalModuleReservations,
  pack: NativeSourceObjectReservations,
): void {
  const owner = requireOwner(tx, pack);
  if (owner.filled) fail("duplicate canonical fill");
  const { kernel } = owner.dependencies;
  // Both re-authenticate their owners, and only the function-object rows read them: computed on first use.
  let operands: BuiltinFunctionPrototypeOperands | undefined;
  let strings: NativeStringLiteralReservations | undefined;
  const context: AdapterContext = {
    ...owner.dependencies,
    tx,
    get operands() {
      return (operands ??= nativeBuiltinFunctionOperands(tx, kernel));
    },
    text: (key) => [
      ...nativeStringLiteralInstrs(
        tx,
        (strings ??= nativeBuiltinFunctionRequestDependencies(tx, kernel.requests).strings),
        TEXT[key],
      ),
      { op: "extern.convert_any" },
    ],
  };
  for (const { feature, arity, token } of pack.served) {
    const row: Row = ROWS[feature];
    if ("body" in row) tx.fillFunction(token, row.body(context, arity));
  }
  owner.filled = true;
}

/** The canonical fill ran, and every served function (adapter or bound) is completed. */
export function requireCompletedNativeSourceObjects(
  tx: PhysicalModuleReservations,
  pack: NativeSourceObjectReservations,
): NativeSourceObjectReservations {
  if (!requireOwner(tx, pack).filled) fail("missing canonical fill");
  for (const { token } of pack.served) tx.assertCompletedReservation(token);
  return pack;
}
