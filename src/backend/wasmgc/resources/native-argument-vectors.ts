// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type {
  PhysicalModuleReservations,
  TypeReservation,
  FunctionReservation,
} from "../../../wasm/physical/module-reservations.js";
import { preparedIrDataMismatch } from "../../../ir/program/data.js";
import { createVectorBaseType } from "../../../runtime/wasmgc/values/vector-grow-store.js";
import {
  createArgumentVectorArrayType,
  createArgumentVectorType,
  createArgumentVectorShape,
  buildArgumentVectorNewBody,
  buildArgumentVectorPushLocals,
  buildArgumentVectorPushBody,
  type ArgumentVectorLayout,
} from "../../../runtime/wasmgc/values/argument-vector-bodies.js";
import type {
  NativeResourceRecipe,
  NativeStringValueDeclaration,
} from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import {
  freezeNativeResourceRecipe,
  preflightNativeResourceRecipe,
  executeNativeResourceRecipe,
  requireNativeDeclaredReservation,
  nativeScalarTypeDeclaration,
  type NativeDeclaredReservation,
} from "./native-resource-declarations.js";

export interface NativeArgumentVectorDeclarationDependencies {
  readonly vectorBaseKey: string;
  readonly earlyArgumentArrayKey?: string;
}
export interface NativeArgumentVectorDeclarationPlan extends NativeResourceRecipe {
  readonly key: string;
  readonly dependencies: NativeArgumentVectorDeclarationDependencies;
  readonly arrayKey: string;
  readonly carrierKey: string;
  readonly newVectorKey: string;
  readonly pushKey: string;
}
export function declareNativeArgumentVectorResources(
  requirements: { readonly key: string },
  dependencies: NativeArgumentVectorDeclarationDependencies,
): NativeArgumentVectorDeclarationPlan {
  if (
    !requirements.key ||
    !dependencies.vectorBaseKey ||
    (Object.hasOwn(dependencies, "earlyArgumentArrayKey") && !dependencies.earlyArgumentArrayKey)
  )
    fail("invalid declaration dependencies");
  const key = (role: string) => `${requirements.key}:${role}`;
  const arrayKey = dependencies.earlyArgumentArrayKey ?? key("array"),
    carrierKey = key("carrier"),
    newVectorKey = key("new"),
    pushKey = key("push");
  const declarations: NativeStringValueDeclaration[] = [];
  if (!dependencies.earlyArgumentArrayKey)
    declarations.push({
      key: arrayKey,
      role: ["argument-vector", "array"],
      space: "type",
      shape: nativeScalarTypeDeclaration(createArgumentVectorArrayType()),
    });
  declarations.push(
    {
      key: carrierKey,
      role: ["argument-vector", "carrier"],
      space: "type",
      shape: createArgumentVectorShape(
        { kind: "ref", typeKey: arrayKey },
        { kind: "resource", typeKey: dependencies.vectorBaseKey },
      ),
    },
    {
      key: newVectorKey,
      role: ["argument-vector", "new"],
      space: "function",
      name: "__objvec_new",
      signature: { params: [], results: [{ kind: "externref" }] },
    },
    {
      key: pushKey,
      role: ["argument-vector", "push"],
      space: "function",
      name: "__objvec_push",
      signature: { params: [{ kind: "externref" }, { kind: "externref" }], results: [] },
    },
  );
  const plan = {
    key: requirements.key,
    dependencies,
    arrayKey,
    carrierKey,
    newVectorKey,
    pushKey,
    declarations,
    reservationSteps: declarations.map((row) => ({
      phase: "resources" as const,
      kind: "reserve" as const,
      resourceKey: row.key,
    })),
  };
  preflightNativeResourceRecipe(plan, [
    dependencies.vectorBaseKey,
    ...(dependencies.earlyArgumentArrayKey ? [dependencies.earlyArgumentArrayKey] : []),
  ]);
  return freezeNativeResourceRecipe(plan);
}

export interface NativeArgumentVectorDependencies {
  readonly vectorBase: TypeReservation;
  /** The SAME ledger's early dynamic-new argv backing, never a legacy index. */
  readonly earlyArgumentArray?: TypeReservation;
}

export interface NativeArgumentVectorReservations {
  readonly vectorBase: TypeReservation;
  readonly array: TypeReservation;
  readonly carrier: TypeReservation;
  readonly layout: ArgumentVectorLayout;
  readonly newVector: FunctionReservation;
  readonly push: FunctionReservation;
}

// Provenance only. The transaction remains the sole allocator/completion authority.
const owners = new WeakMap<
  NativeArgumentVectorReservations,
  {
    tx: PhysicalModuleReservations;
    filled: boolean;
    plan: NativeArgumentVectorDeclarationPlan;
    requirements: { readonly key: string };
    dependencies: NativeArgumentVectorDependencies;
    records: ReadonlyMap<string, NativeDeclaredReservation>;
  }
>();

function fail(detail: string): never {
  throw new Error(`native argument vectors: ${detail}`);
}

function same(actual: unknown, expected: unknown, detail: string): void {
  if (preparedIrDataMismatch(actual, expected) !== undefined) fail(detail);
}

function validateLayouts(pack: NativeArgumentVectorReservations): void {
  same(pack.vectorBase.object, createVectorBaseType(), "noncanonical vector base");
  same(pack.array.object, createArgumentVectorArrayType(), "noncanonical argument backing");
  same(
    pack.carrier.object,
    createArgumentVectorType(pack.vectorBase.typeIndex, pack.array.typeIndex),
    "noncanonical argument carrier",
  );
}

/**
 * Authenticate both prerequisite tokens before any allocation. Matching numeric
 * indices or descriptor copies do not confer ownership in this transaction.
 */
export function reserveNativeArgumentVectorResources(
  tx: PhysicalModuleReservations,
  requirements: { readonly key: string },
  dependencies: NativeArgumentVectorDependencies,
  expectedPlan?: NativeArgumentVectorDeclarationPlan,
): NativeArgumentVectorReservations {
  if (tx.state !== "reserving" || !requirements.key) fail("invalid reservation phase/key");
  tx.assertTypeReservation(dependencies.vectorBase);
  if (dependencies.earlyArgumentArray) tx.assertTypeReservation(dependencies.earlyArgumentArray);
  same(dependencies.vectorBase.object, createVectorBaseType(), "noncanonical vector base");
  if (dependencies.earlyArgumentArray) {
    same(
      dependencies.earlyArgumentArray.object,
      createArgumentVectorArrayType(),
      "noncanonical early argument backing",
    );
  }
  const derived = declareNativeArgumentVectorResources(requirements, {
    vectorBaseKey: dependencies.vectorBase.key,
    ...(dependencies.earlyArgumentArray ? { earlyArgumentArrayKey: dependencies.earlyArgumentArray.key } : {}),
  });
  if (expectedPlan) same(derived, expectedPlan, "substituted argument-vector declaration plan");
  const plan = expectedPlan ?? derived;
  const prerequisites = [
    dependencies.vectorBase,
    ...(dependencies.earlyArgumentArray ? [dependencies.earlyArgumentArray] : []),
  ];
  const records = executeNativeResourceRecipe(tx, plan, new Map(prerequisites.map((token) => [token.key, token])));
  const array = dependencies.earlyArgumentArray ?? requireNativeDeclaredReservation(records, plan.arrayKey, "type");
  const carrier = requireNativeDeclaredReservation(records, plan.carrierKey, "type");
  const newVector = requireNativeDeclaredReservation(records, plan.newVectorKey, "function");
  const push = requireNativeDeclaredReservation(records, plan.pushKey, "function");
  const pack = Object.freeze({
    vectorBase: dependencies.vectorBase,
    array,
    carrier,
    layout: Object.freeze({ objVecArrTypeIdx: array.typeIndex, objVecTypeIdx: carrier.typeIndex }),
    newVector,
    push,
  });
  owners.set(pack, { tx, filled: false, plan, requirements, dependencies, records });
  return pack;
}

export function nativeArgumentVectorReservationInventory(
  tx: PhysicalModuleReservations,
  pack: NativeArgumentVectorReservations,
  expectedPlan: NativeArgumentVectorDeclarationPlan,
): readonly NativeDeclaredReservation[] {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx || owner.plan !== expectedPlan)
    fail("foreign or substituted argument-vector declaration plan");
  if (
    owner.dependencies.vectorBase !== pack.vectorBase ||
    (owner.dependencies.earlyArgumentArray && owner.dependencies.earlyArgumentArray !== pack.array)
  )
    fail("stale argument-vector dependency");
  same(
    declareNativeArgumentVectorResources(owner.requirements, {
      vectorBaseKey: pack.vectorBase.key,
      ...(owner.dependencies.earlyArgumentArray ? { earlyArgumentArrayKey: pack.array.key } : {}),
    }),
    expectedPlan,
    "stale argument-vector requirements",
  );
  for (const type of [pack.vectorBase, pack.array, pack.carrier]) {
    if (tx.state === "reserving") tx.assertTypeReservation(type);
    else tx.physicalIndex(type);
  }
  validateLayouts(pack);
  return Object.freeze(
    expectedPlan.declarations.map((row) => {
      const token = owner.records.get(row.key);
      if (!token) fail("missing argument-vector reservation");
      if (tx.state !== "reserving") tx.physicalIndex(token);
      return token;
    }),
  );
}

/** Fill both actual implementations; never freeze, seal, allocate, or publish here. */
export function fillNativeArgumentVectorResources(
  tx: PhysicalModuleReservations,
  pack: NativeArgumentVectorReservations,
): void {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or forged resource owner");
  if (owner.filled) fail("duplicate fill");
  // Authenticate every dependency BEFORE filling either function. The ledger
  // also rejects replaced descriptors and stale nested layout objects here.
  for (const token of [pack.vectorBase, pack.array, pack.carrier]) {
    if (tx.physicalIndex(token) !== token.typeIndex) fail("type coordinate mismatch");
  }
  tx.physicalIndex(pack.newVector);
  tx.physicalIndex(pack.push);
  validateLayouts(pack);
  tx.fillFunction(pack.newVector, { locals: [], body: buildArgumentVectorNewBody(pack.layout) });
  tx.fillFunction(pack.push, {
    locals: buildArgumentVectorPushLocals(pack.layout),
    body: buildArgumentVectorPushBody(pack.layout),
  });
  owner.filled = true;
}
