// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O1) The public source-callable functions on the realm. A source program reaches an ordinary object only
 * through the `js.object.*` contracts (`ordinary-object-callables.ts`), and (#7354 C) a function object through the
 * `js.function.*` contracts (`function-object-callables.ts`); each contract it calls binds one function here, whose
 * signature is the contract's and whose algorithm is the realm's own:
 *   - `define-data` is the descriptor pack's public define, bound as it is;
 *   - every other served contract is an adapter (`source-object-bodies.ts`, `source-function-object-bodies.ts`) over
 *     the storage pack, the builtin-object kernel and the closure invocation.
 * A contract without a row here has no native source provider yet.
 */
import type { FunctionReservation, PhysicalModuleReservations } from "../../../wasm/physical/module-reservations.js";
import type { Instr, ValType } from "../../../wasm/model/instructions.js";
import type {
  FunctionObjectRuntimeFeature,
  OrdinaryObjectRuntimeFeature,
} from "../../../ir/runtime/contracts/manifest.js";
import { arityCallableArity } from "../../../ir/core/closure-invocation-callables.js";
import {
  FUNCTION_OBJECT_INIT_FLAGS,
  IR_FUNCTION_CONSTRUCT_PREFIX,
} from "../../../ir/runtime/function-object-callables.js";
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
import type { NativeInvocationReservations } from "./native-invocation.js";
import type { NativeObjectDescriptorReservations } from "./native-object-descriptors.js";
import type { NativeObjectLayoutReservations } from "./native-object-layouts.js";
import type { NativeObjectStorageReservations } from "./native-object-storage.js";
import { nativeStringLiteralInstrs, type NativeStringLiteralReservations } from "./native-string-literals.js";

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
  unboundSloppy: "TypeError: unbound sloppy this needs the realm global object",
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
 * One adapter: the contract's fixed signature and its body over the realm's packs. A family row
 * (`js.function.construct:N`) takes `arity` more externref operands after the fixed ones; every other row has none.
 */
interface Adapter {
  readonly signature: { readonly params: readonly ValType[]; readonly results: readonly ValType[] };
  readonly body: (context: AdapterContext, arity: number) => SourceObjectDefinition;
}
function fail(detail: string): never {
  throw new Error("native source objects: " + detail);
}
const create = ({ layouts, storage, kernel }: NativeSourceObjectDependencies): SourceObjectCreateOperands => ({
  objectTypeIdx: layouts.object.typeIndex,
  objectPrototype: kernel.functions.objectPrototype.handle,
  createWithPrototype: storage.createWithPrototype.handle,
});
/** `this` and `construct` run inside the closure invocation, which a realm with source closures reserves. */
function invocation(context: AdapterContext): NativeInvocationReservations {
  return context.invocation ?? fail("a function-object adapter needs the realm's closure invocation");
}
/** The adapters this module owns. A new realm-served contract is one row. */
const ADAPTERS = {
  "js.object.create-default": {
    signature: { params: [], results: [EXTERNREF] },
    body: (context) => buildSourceObjectCreateDefinition(create(context)),
  },
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
} as const satisfies Readonly<Partial<Record<OrdinaryObjectRuntimeFeature | FunctionObjectRuntimeFeature, Adapter>>>;
type Adapted = keyof typeof ADAPTERS;

/** The adapter and operand count that serve a contract symbol, or `undefined` when no row serves it. */
function served(symbol: string): { readonly feature: Adapted; readonly arity: number } | undefined {
  const arity = arityCallableArity(IR_FUNCTION_CONSTRUCT_PREFIX, symbol);
  if (arity !== undefined) return { feature: "js.function.construct", arity };
  return symbol !== "js.function.construct" && Object.hasOwn(ADAPTERS, symbol)
    ? { feature: symbol as Adapted, arity: 0 }
    : undefined;
}

/**
 * The reservation key of the function that serves the contract `symbol` in the realm keyed `realmKey`, or `undefined`
 * when the contract has no native source provider. The physical plan's binding rows and the reservations below both
 * use it.
 */
export function nativeSourceObjectResourceKey(realmKey: string, symbol: string): string | undefined {
  if (symbol === "js.object.define-data") return realmKey + ":descriptors:define-data";
  return served(symbol) ? realmKey + ":source-objects:" + symbol : undefined;
}

export interface NativeSourceObjectDependencies {
  readonly layouts: NativeObjectLayoutReservations;
  readonly storage: NativeObjectStorageReservations;
  readonly descriptors: NativeObjectDescriptorReservations;
  readonly kernel: NativeBuiltinFunctionReservations;
  /** The closure invocation of a realm with source closures; `this` and `construct` dispatch through it. */
  readonly invocation?: NativeInvocationReservations;
}
export interface NativeSourceObjectReservations {
  /** One function per served contract symbol (`js.function.construct:N` per arity). */
  readonly adapters: ReadonlyMap<string, FunctionReservation>;
  readonly dependencies: NativeSourceObjectDependencies;
}

/** One adapter per served contract symbol the program calls; `define-data` needs none. */
export function reserveNativeSourceObjectResources(
  tx: PhysicalModuleReservations,
  realmKey: string,
  symbols: readonly string[],
  dependencies: NativeSourceObjectDependencies,
): NativeSourceObjectReservations {
  const adapters = new Map(
    [...new Set(symbols)].sort().flatMap((symbol) => {
      const row = served(symbol);
      if (!row) return [];
      const key = nativeSourceObjectResourceKey(realmKey, symbol)!;
      const { params, results } = ADAPTERS[row.feature].signature;
      const signature = { params: [...params, ...Array<ValType>(row.arity).fill(EXTERNREF)], results: [...results] };
      return [[symbol, tx.reserveFunction(key, key, signature)] as const];
    }),
  );
  return Object.freeze({ adapters, dependencies });
}

export function fillNativeSourceObjectResources(
  tx: PhysicalModuleReservations,
  pack: NativeSourceObjectReservations,
): void {
  const { kernel } = pack.dependencies;
  // Both re-authenticate their owners, and only the function-object rows read them: computed on first use.
  let operands: BuiltinFunctionPrototypeOperands | undefined;
  let strings: NativeStringLiteralReservations | undefined;
  const context: AdapterContext = {
    ...pack.dependencies,
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
  for (const [symbol, token] of pack.adapters) {
    const { feature, arity } = served(symbol)!;
    tx.fillFunction(token, ADAPTERS[feature].body(context, arity));
  }
}
