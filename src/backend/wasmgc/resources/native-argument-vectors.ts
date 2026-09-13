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
  buildArgumentVectorNewBody,
  buildArgumentVectorPushLocals,
  buildArgumentVectorPushBody,
  type ArgumentVectorLayout,
} from "../../../runtime/wasmgc/values/argument-vector-bodies.js";

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
const owners = new WeakMap<NativeArgumentVectorReservations, { tx: PhysicalModuleReservations; filled: boolean }>();

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
  const key = (role: string) => `${requirements.key}:${role}`;
  const array = dependencies.earlyArgumentArray ?? tx.reserveType(key("array"), createArgumentVectorArrayType());
  const carrier = tx.reserveType(
    key("carrier"),
    createArgumentVectorType(dependencies.vectorBase.typeIndex, array.typeIndex),
  );
  // Preserve the donor's new-before-push function signature/registration order.
  const newVector = tx.reserveFunction(key("new"), "__objvec_new", {
    params: [],
    results: [{ kind: "externref" }],
  });
  const push = tx.reserveFunction(key("push"), "__objvec_push", {
    params: [{ kind: "externref" }, { kind: "externref" }],
    results: [],
  });
  const pack = Object.freeze({
    vectorBase: dependencies.vectorBase,
    array,
    carrier,
    layout: Object.freeze({ objVecArrTypeIdx: array.typeIndex, objVecTypeIdx: carrier.typeIndex }),
    newVector,
    push,
  });
  owners.set(pack, { tx, filled: false });
  return pack;
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
