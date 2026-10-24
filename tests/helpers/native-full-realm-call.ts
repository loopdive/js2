// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect } from "vitest";
import { setImmediate } from "node:timers/promises";
import { mixedOwnerFixture, reserveMixedOwner, fillMixedDependencies } from "./native-mixed-object-access.js";
import { publicRealmSourceSlots } from "./native-object-realm.js";
import {
  reserveNativeBooleanResources,
  fillNativeBooleanResources,
} from "../../src/backend/wasmgc/resources/native-booleans.js";
import {
  reserveNativeObjectRealmCalls,
  fillNativeObjectRealmCalls,
} from "../../src/backend/wasmgc/resources/native-object-realm-calls.js";
import {
  reserveNativeInvocationResources,
  bindNativeInvocationObjectRealm,
  fillNativeInvocationResources,
} from "../../src/backend/wasmgc/resources/native-invocation.js";
import {
  bindNativeMixedObjectInvocation,
  bindNativeMixedObjectPopulation,
  bindNativeMixedObjectPromises,
  fillNativeMixedObjectAccessStructure,
  fillNativeMixedObjectGet,
} from "../../src/backend/wasmgc/resources/native-mixed-object-access.js";
import { fillNativeObjectRealmDeclarations } from "../../src/backend/wasmgc/resources/native-object-realm.js";
import { planNativeInvocationRequirements } from "../../src/ir/program/native-invocation-requirements.js";
import {
  bindNativeSourceClosureUnits,
  nativeSourceClosureCallableBindings,
  nativeRealmSourceClosureCallableBindings,
  nativeSourceClosureResolver,
  fillPreparedPrimaryUnit,
  bindPreparedNativePromiseInvocation,
} from "../../src/ir/program-native-invocation.js";
import type { IrLowerResolver } from "../../src/ir/backend/lower-contracts.js";
import { reserveRealmPopulationFixture, fillRealmPopulationFixture } from "./native-realm-population.js";
import { planNativePromiseResources } from "../../src/ir/program-native-async-resources.js";
import {
  declareNativePromiseResources,
  reserveNativePromiseResources,
} from "../../src/backend/wasmgc/resources/native-promises.js";
import {
  reserveNativePromiseObjects,
  fillNativePromiseObjects,
} from "../../src/backend/wasmgc/resources/native-promise-objects.js";

export function fullRealmFixture(displaced = false, asyncSource = "") {
  const r = mixedOwnerFixture(
      displaced,
      `export function makeCaptured(seed: number): (value: number) => number {
    return function captured(value: number): number { return seed + value; };
  }
  export function makeEmpty(): () => number { return function empty(): number { return 7; }; }` + asyncSource,
      ["then", "missingPromiseProperty"],
    ),
    { tx, f, c } = r;
  const source = publicRealmSourceSlots(f, c);
  const booleans = reserveNativeBooleanResources(tx, "test:booleans", r.values, r.valuePlan, r.valueDependencies);
  const dependencies = {
    realm: r.realm.declarations,
    realmDependencies: r.realm.dependencies,
    values: r.values,
    valuePlan: r.valuePlan,
    valueDependencies: r.valueDependencies,
    booleans,
  };
  const calls = reserveNativeObjectRealmCalls(tx, "test:realm-calls", dependencies);
  const requirements = planNativeInvocationRequirements(c.source!.requirements, { utf8Storage: displaced })!;
  const promise = r.c.source!.requirements.promiseClosures ? reservePromise(r, displaced) : undefined;
  const invocation = reserveNativeInvocationResources(tx, requirements, {
    source: c.source!.types,
    values: r.values,
    valuePlan: r.valuePlan,
    valueDependencies: r.valueDependencies,
    strings: f.strings,
    vectors: f.vectors,
    vectorPlan: f.vectorPlan,
    substrate: f.substrate,
    ...(promise ? { promise: promise.association } : {}),
  });
  const access = reserveMixedOwner(r);
  const population = reserveRealmPopulationFixture(r, booleans, calls);
  const promiseObjects = promise
    ? reserveNativePromiseObjects(tx, "test:promise-objects", population.pack, promise.association)
    : undefined;
  return { ...r, source, booleans, dependencies, calls, invocation, access, population, promise, promiseObjects };
}

export function joinFullRealm(r: ReturnType<typeof fullRealmFixture>) {
  bindNativeInvocationObjectRealm(r.tx, r.invocation, r.calls);
  bindNativeMixedObjectInvocation(r.tx, r.access, r.invocation);
  bindNativeMixedObjectPopulation(r.tx, r.access, r.population.pack);
  if (r.promiseObjects) bindNativeMixedObjectPromises(r.tx, r.access, r.promiseObjects);
}

export async function fillFullRealm(r: ReturnType<typeof fullRealmFixture>, dispatch = true) {
  const { tx, f, c } = r;
  tx.freezeReservations();
  bindNativeSourceClosureUnits(tx, c.source!, r.source.slots);
  fillMixedDependencies(r);
  await setImmediate();
  fillNativeBooleanResources(tx, r.booleans);
  fillNativeObjectRealmDeclarations(tx, r.realm.declarations);
  if (dispatch) fillNativeObjectRealmCalls(tx, r.calls);
  fillRealmPopulationFixture(r, r.population);
  if (r.promiseObjects) fillNativePromiseObjects(tx, r.promiseObjects);
  await setImmediate();
  const selected = nativeSourceClosureCallableBindings(tx, c.source!, r.invocation.requirements);
  expect(() => fillNativeInvocationResources(tx, r.invocation, selected, f.exception.tag)).toThrow(
    /requires all source callables/,
  );
  const all = nativeRealmSourceClosureCallableBindings(tx, c.source!, f.realm);
  fillNativeInvocationResources(tx, r.invocation, selected, f.exception.tag, all);
  await setImmediate();
  fillNativeMixedObjectAccessStructure(tx, r.access);
  await setImmediate();
  fillNativeMixedObjectGet(tx, r.access);
}

export function fillFullRealmSourceUnits(r: ReturnType<typeof fullRealmFixture>) {
  const { tx, f, c } = r;
  const resolver: IrLowerResolver = {
    ...nativeSourceClosureResolver(tx, c.source!),
    resolveFunc(ref) {
      const slot = ref.binding.kind === "unit" && r.source.slots.get(ref.binding.unitId);
      if (slot) return slot.handle;
      throw Error("unexpected callable");
    },
    resolveGlobal() {
      throw Error("unexpected global");
    },
    resolveType() {
      throw Error("unexpected type");
    },
    internFuncType(sig) {
      return tx.internFunctionType(sig.params, sig.results);
    },
  };
  for (const [id, slot] of r.source.slots)
    fillPreparedPrimaryUnit(
      tx,
      f.projection.prepared.functions.find((row) => row.unitId === id)!,
      slot,
      r.source.signatures.get(id)!,
      resolver,
      "wasmgc",
      c.source,
    );
}

function reservePromise(r: ReturnType<typeof mixedOwnerFixture>, displaced: boolean) {
  const options = {
    backend: "wasmgc",
    target: "standalone",
    utf8Storage: displaced,
    sharedExceptionTag: false,
    sourceMap: false,
    moduleName: "promise-realm",
  } as const;
  const configuration = { hooks: "disabled", unhandledRejections: "disabled" } as const;
  const plan = planNativePromiseResources(r.f.program, options, r.f.projection, configuration);
  const metadataId = r.c.source!.requirements.promiseClosures!.metadataId;
  const metadata = r.c.closures.metadata.find((row) => row.id === metadataId)!.binding;
  const declaration = declareNativePromiseResources(plan, {
    argumentArrayKey: r.f.vectors.layouts.find((row) => row.element === "externref")!.array.key,
    closureRootKey: r.c.closures.root.key,
    settleMetadataKey: metadata.type.key,
  });
  const resources = reserveNativePromiseResources(
    r.tx,
    plan,
    {
      vectors: r.f.vectors,
      exceptionTag: r.f.exception.tag,
      closures: r.c.closures,
      settleMetadataRequestId: metadataId,
    },
    declaration,
  );
  const association = bindPreparedNativePromiseInvocation(
    r.tx,
    r.c.source!,
    resources,
    declaration,
    options,
    configuration,
  );
  return { resources, association, declaration, plan };
}
