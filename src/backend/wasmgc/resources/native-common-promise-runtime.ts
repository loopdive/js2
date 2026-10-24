// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../../../wasm/model/instructions.js";
import type { PhysicalModuleReservations } from "../../../wasm/physical/module-reservations.js";
import { NATIVE_PROMISE_STRINGS } from "../../../runtime/contracts/native-promise-literals.js";
import { nativePromiseResolutionDefinitions } from "./native-promise-resolution.js";
import { buildPromisePeelValue } from "../../../runtime/wasmgc/promise/thenable-bodies.js";
import type { NativeInvocationReservations } from "./native-invocation.js";
import { requireNativePromiseInvocation, type NativePromiseInvocation } from "./native-promise-invocation.js";
import { nativePromiseObjectBinding, type NativePromiseObjects } from "./native-promise-objects.js";
import { nativePromiseThenLookupBinding, type NativePromiseThenLookup } from "./native-promise-then-lookup.js";
import { nativePromiseKernelDefinitions, fillNativePromiseKernelDefinitions } from "./native-promise-kernel.js";
import { requireCanonicalNativeFunctions } from "./native-resource-declarations.js";
import { requireNativeStringLiteral } from "./native-string-literals.js";

export interface NativeCommonPromiseRuntime {
  readonly objects: NativePromiseObjects;
  readonly association: NativePromiseInvocation;
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly invocation: NativeInvocationReservations;
  readonly lookup: NativePromiseThenLookup;
  filled: boolean;
}
const owners = new WeakMap<NativeCommonPromiseRuntime, Owner>();
const producers = new WeakSet<NativePromiseObjects>();
function fail(detail: string): never {
  throw Error("native common Promise runtime: " + detail);
}
function bindings(pack: NativeCommonPromiseRuntime, owner: Owner, completed = false) {
  const { tx } = owner;
  const lookup = nativePromiseThenLookupBinding(tx, owner.lookup, owner.invocation, completed);
  const objects = nativePromiseObjectBinding(tx, pack.objects, completed);
  const association = requireNativePromiseInvocation(tx, pack.association, lookup.call.source);
  if (
    pack.association.promise !== pack.objects.promise ||
    objects.realm !== lookup.call.realm ||
    association.exceptionTag !== lookup.call.exception
  )
    fail("different Promise, realm or exception owner");
  if (association.configuration.hooks !== "disabled" || association.configuration.unhandledRejections !== "disabled")
    fail("hook and rejection-tracking producers are not joined");
  const self = requireNativeStringLiteral(tx, lookup.call.strings, NATIVE_PROMISE_STRINGS.selfResolution);
  return { ...lookup, objects, association, self };
}
/** Join the actual source, object, Get and Call owners before finalizing their mutually recursive bodies. */
export function reserveNativeCommonPromiseRuntime(
  tx: PhysicalModuleReservations,
  objects: NativePromiseObjects,
  association: NativePromiseInvocation,
  invocation: NativeInvocationReservations,
  lookup: NativePromiseThenLookup,
): NativeCommonPromiseRuntime {
  if (tx.state !== "reserving") fail("invalid reservation phase");
  const pack = Object.freeze({ objects, association });
  const owner = { tx, invocation, lookup, filled: false };
  bindings(pack, owner);
  if (producers.has(objects)) fail("Promise already has a common runtime producer");
  owners.set(pack, owner);
  producers.add(objects);
  return pack;
}
function current(tx: PhysicalModuleReservations, pack: NativeCommonPromiseRuntime) {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied owner");
  return owner;
}
function definitions(pack: NativeCommonPromiseRuntime, owner: Owner) {
  const { tx } = owner;
  const d = bindings(pack, owner, true),
    promise = pack.objects.promise;
  const f = promise.functions;
  const literal = (value: typeof d.self): Instr[] => [
    value.kind === "global"
      ? { op: "global.get", index: tx.physicalIndex(value.global) }
      : { op: "call", funcIdx: value.function.handle },
    { op: "extern.convert_any" },
  ];
  const resolution = nativePromiseResolutionDefinitions(promise, {
    commonGet: true,
    metadataType: d.association.metadata.type.typeIndex,
    closureRoot: d.call.closures.root.typeIndex,
    exn: tx.physicalIndex(d.call.exception),
    newTypeError: d.call.errors.newTypeError.handle,
    selfString: literal(d.self),
    thenString: literal(d.key),
    argumentNew: d.call.arguments.newVector.handle,
    argumentPush: d.call.arguments.push.handle,
    apply: d.call.call.handle,
  });
  return nativePromiseKernelDefinitions(tx, promise, {
    metadataType: d.association.metadata.type.typeIndex,
    hook: undefined,
    unhandledHead: -1,
    unhandledNode: -1,
    ...resolution,
    peel: buildPromisePeelValue({
      typeIdx: d.call.values.types.anyValue.typeIndex,
      tagFieldIdx: 0,
      refFieldIdx: 3,
      externFieldIdx: 4,
    }),
    classifier: {
      locals: [],
      body: [{ op: "local.get", index: 0 }, { op: "call", funcIdx: f.lookupThen.handle }, { op: "drop" }],
    },
    lookupThen: {
      locals: [],
      body: [
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: d.lookup.handle },
      ],
    },
  });
}
export function fillNativeCommonPromiseRuntime(tx: PhysicalModuleReservations, pack: NativeCommonPromiseRuntime): void {
  const owner = current(tx, pack);
  if (tx.state !== "filling" || owner.filled) fail("invalid phase or duplicate fill");
  fillNativePromiseKernelDefinitions(tx, pack.objects.promise, definitions(pack, owner));
  owner.filled = true;
}
/** Core resolution/settlement only: public algorithms, allocation sites and admission still need their own owners. */
export function nativeCommonPromiseRuntimeBinding(tx: PhysicalModuleReservations, pack: NativeCommonPromiseRuntime) {
  const owner = current(tx, pack);
  if (!owner.filled) fail("missing canonical runtime fill");
  const rows = definitions(pack, owner);
  requireCanonicalNativeFunctions(tx, rows.functions);
  for (const { token } of rows.globals) tx.assertCompletedReservation(token);
  return { ...bindings(pack, owner, true), promise: pack.objects.promise };
}
