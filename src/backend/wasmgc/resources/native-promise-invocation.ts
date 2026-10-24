// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { PhysicalModuleReservations } from "../../../wasm/physical/module-reservations.js";
import type { NativePromiseResourcePlan } from "../../../ir/program/native-promise-resources.js";
import { requireNativeSourceClosureTypes, type NativeSourceClosureTypes } from "./native-source-closures.js";
import {
  requireNativePromiseSettlementBinding,
  type NativePromiseReservations,
  type NativePromiseDeclarationPlan,
} from "./native-promises.js";

export interface NativePromiseInvocation {
  readonly source: NativeSourceClosureTypes;
  readonly promise: NativePromiseReservations;
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly declaration: NativePromiseDeclarationPlan;
  readonly plan: NativePromiseResourcePlan;
}
const owners = new WeakMap<NativePromiseInvocation, Owner>();
function fail(detail: string): never {
  throw new Error(`native Promise invocation: ${detail}`);
}
/** The checked program coordinator supplies the expected source plan, independently of the reserved pack. */
export function bindNativePromiseInvocation(
  tx: PhysicalModuleReservations,
  source: NativeSourceClosureTypes,
  promise: NativePromiseReservations,
  declaration: NativePromiseDeclarationPlan,
  plan: NativePromiseResourcePlan,
): NativePromiseInvocation {
  if (tx.state !== "reserving") fail("association requires reservation phase");
  const pack = Object.freeze({ source, promise });
  owners.set(pack, { tx, declaration, plan });
  requireNativePromiseInvocation(tx, pack, source);
  return pack;
}
export function requireNativePromiseInvocation(
  tx: PhysicalModuleReservations,
  pack: NativePromiseInvocation,
  source: NativeSourceClosureTypes,
  completed = false,
) {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx || pack.source !== source) fail("foreign, copied or substituted association");
  requireNativeSourceClosureTypes(tx, source, source.requirements);
  const selected = source.requirements.promiseClosures;
  if (!selected) fail("source has no selected native Promise closure demand");
  return requireNativePromiseSettlementBinding(
    tx,
    pack.promise,
    owner.declaration,
    owner.plan,
    source.closures,
    selected.metadataId,
    completed,
  );
}
