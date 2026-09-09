// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { NativeStringValueDemands } from "../../../ir/program/native-string-value-demands.js";
import type { NativePromiseResourcePlan } from "../../../ir/program/native-promise-resources.js";
import { freezePreparedIrValue, preparedIrDataMismatch } from "../../../ir/program/data.js";
import { IR_NATIVE_PROMISE_DELAY_FN, IR_ASYNC_PROMISE_ALL_NATIVE_FN } from "../../../ir/core/async-callables.js";
import type {
  PhysicalModuleReservations,
  TypeReservation,
  FunctionReservation,
} from "../../../wasm/physical/module-reservations.js";
import type {
  NativeResourceRecipe,
  NativeDeclaredType,
  NativeDeclaredSignature,
  NativeStringValueDeclaration,
  NativeStringValueReservationStep,
} from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import {
  createNativeDelayCaptureShape,
  createNativeCombinatorStateShape,
  createNativeCombinatorElementShape,
} from "../../../runtime/wasmgc/promise/delay-combinator-layouts.js";
import {
  declareNativeClosureResources,
  nativeClosureReservationInventory,
  type NativeClosureDeclarationPlan,
  type NativeClosureReservations,
} from "./native-closures.js";
import {
  declareNativePromiseResources,
  nativePromiseReservationInventory,
  assertNativePromiseResourcePlanFor,
  type NativePromiseDeclarationPlan,
  type NativePromiseReservations,
} from "./native-promises.js";
import { resolveNativeVectorForElement, type NativeVectorTypeReservations } from "./native-vectors.js";
import {
  freezeNativeResourceRecipe,
  preflightNativeResourceRecipe,
  executeNativeResourceRecipe,
  requireNativeDeclaredReservation,
  type NativeDeclaredReservation,
} from "./native-resource-declarations.js";

export interface NativeDelayCombinatorSelection {
  readonly delaySignatureRequestId?: string;
  readonly settleMetadataRequestId: string;
}
export interface NativeDelayCombinatorRequirements {
  readonly key: string;
  readonly demands: NativeStringValueDemands;
  readonly promiseRequirements: NativePromiseResourcePlan;
  readonly requests: NativeDelayCombinatorSelection;
  readonly uses: readonly { readonly occurrence: number; readonly kind: "delay" | "all" }[];
  readonly delay: boolean;
  readonly all: boolean;
}
export interface NativeDelayCombinatorDeclarationDependencies {
  readonly closurePlan: NativeClosureDeclarationPlan;
  readonly promisePlan: NativePromiseDeclarationPlan;
  readonly vectorCarrierKey: string;
  readonly vectorArrayKey: string;
}
export interface NativeDelayCombinatorDeclarationPlan extends NativeResourceRecipe {
  readonly key: string;
  readonly dependencies: {
    readonly closureRootKey: string;
    readonly settleMetadataKey: string;
    readonly promiseTypeKey: string;
    readonly vectorCarrierKey: string;
    readonly vectorArrayKey: string;
    readonly delayWrapperKey?: string;
    readonly delayLiftedSignatureKey?: string;
  };
}
export interface NativeDelayCombinatorReservationDependencies {
  readonly closures: NativeClosureReservations;
  readonly closurePlan: NativeClosureDeclarationPlan;
  readonly promises: NativePromiseReservations;
  readonly promisePlan: NativePromiseDeclarationPlan;
  readonly vectors: NativeVectorTypeReservations;
}
export interface NativeDelayCombinatorReservations {
  readonly delay?: {
    readonly capture: TypeReservation;
    readonly callback: FunctionReservation;
    readonly provider: FunctionReservation;
  };
  readonly all?: {
    readonly state: TypeReservation;
    readonly element: TypeReservation;
    readonly subscribe: FunctionReservation;
    readonly allFulfill: FunctionReservation;
    readonly raceFulfill: FunctionReservation;
    readonly reject: FunctionReservation;
    readonly provider: FunctionReservation;
  };
}
const EXTERN = { kind: "externref" } as const;
const F64 = { kind: "f64" } as const;
function fail(detail: string): never {
  throw new Error("native delay/combinator reservations: " + detail);
}
function same(a: unknown, b: unknown, label: string): void {
  if (preparedIrDataMismatch(a, b) !== undefined) fail(label);
}
function unique<T>(rows: readonly T[], label: string): T {
  if (rows.length !== 1) fail(label);
  return rows[0]!;
}
function checkedDeclarationInputs(
  r: NativeDelayCombinatorRequirements,
  d: NativeDelayCombinatorDeclarationDependencies,
): { dependencies: NativeDelayCombinatorDeclarationPlan["dependencies"]; lifted: NativeDeclaredSignature | undefined } {
  if (!r.key || typeof r.delay !== "boolean" || typeof r.all !== "boolean" || (!r.delay && !r.all))
    fail("empty/invalid selection");
  if (!r.requests.settleMetadataRequestId || typeof r.requests.settleMetadataRequestId !== "string")
    fail("missing settle request");
  if (
    r.delay
      ? !Object.hasOwn(r.requests, "delaySignatureRequestId") ||
        typeof r.requests.delaySignatureRequestId !== "string" ||
        !r.requests.delaySignatureRequestId
      : Object.hasOwn(r.requests, "delaySignatureRequestId")
  )
    fail("invalid delay request presence");
  same(declareNativeClosureResources(d.closurePlan.requirements), d.closurePlan, "noncanonical closure recipe");
  const metadata = unique(
    d.closurePlan.metadata.filter((row) => row.requestId === r.requests.settleMetadataRequestId),
    "missing/duplicate settle metadata",
  );
  const request = unique(
    d.closurePlan.requirements.requests.filter((row) => row.id === r.requests.settleMetadataRequestId),
    "missing settle request",
  );
  if (request.kind !== "metadata" || request.key !== "promise:settle" || request.name !== "" || request.length !== 1)
    fail("wrong settle metadata");
  const settleSignature = unique(
    d.closurePlan.requirements.requests.filter((row) => row.id === request.signatureId),
    "missing settle signature",
  );
  if (settleSignature.kind !== "signature" || settleSignature.allocationMode !== "ordinary")
    fail("wrong settle signature mode");
  same([settleSignature.params, settleSignature.results], [[EXTERN], []], "wrong settle signature");
  same(
    declareNativePromiseResources(r.promiseRequirements, {
      argumentArrayKey: d.vectorArrayKey,
      closureRootKey: d.closurePlan.rootKey,
      settleMetadataKey: metadata.typeKey,
    }),
    d.promisePlan,
    "noncanonical Promise recipe",
  );
  const promise = unique(
    d.promisePlan.declarations.filter(
      (row) => row.space === "type" && preparedIrDataMismatch(row.role, ["promise", "carrier"]) === undefined,
    ),
    "missing/duplicate Promise carrier",
  );
  if (!d.vectorCarrierKey || !d.vectorArrayKey || d.vectorCarrierKey === d.vectorArrayKey) fail("invalid vector keys");
  const base = {
    closureRootKey: d.closurePlan.rootKey,
    settleMetadataKey: metadata.typeKey,
    promiseTypeKey: promise.key,
    vectorCarrierKey: d.vectorCarrierKey,
    vectorArrayKey: d.vectorArrayKey,
  };
  if (!r.delay) return { dependencies: base, lifted: undefined };
  const delay = unique(
    d.closurePlan.requirements.requests.filter((row) => row.id === r.requests.delaySignatureRequestId),
    "missing/duplicate delay request",
  );
  if (
    delay.kind !== "signature" ||
    delay.params.length ||
    delay.results.length ||
    delay.allocationMode !== "host-one-shot" ||
    Object.hasOwn(delay, "minimumArgumentCount")
  )
    fail("wrong delay signature request");
  if (d.closurePlan.metadata.some((row) => row.signatureRequestId === delay.id)) fail("invented delay metadata");
  const row = unique(
    d.closurePlan.signatures.filter((row) => row.requestId === delay.id),
    "missing delay signature row",
  );
  const step = unique(
    d.closurePlan.reservationSteps.filter(
      (step) => step.kind === "intern-signature" && step.key === row.liftedSignatureKey,
    ),
    "missing lifted signature step",
  );
  if (step.kind !== "intern-signature") fail("wrong lifted step");
  same(
    step.signature,
    { params: [{ kind: "ref", typeKey: d.closurePlan.rootKey }], results: [] },
    "wrong lifted root signature",
  );
  return {
    dependencies: { ...base, delayWrapperKey: row.wrapperKey, delayLiftedSignatureKey: row.liftedSignatureKey },
    lifted: step.signature,
  };
}

/** Pure descriptive recipe. Complete source admission belongs to the checked parent wrapper. */
export function declareNativeDelayCombinatorResources(
  r: NativeDelayCombinatorRequirements,
  d: NativeDelayCombinatorDeclarationDependencies,
): NativeDelayCombinatorDeclarationPlan {
  const { dependencies, lifted } = checkedDeclarationInputs(r, d);
  const declarations: NativeStringValueDeclaration[] = [];
  const reservationSteps: NativeStringValueReservationStep[] = [];
  const key = (role: string) => r.key + ":" + role;
  const add = (row: NativeStringValueDeclaration) => {
    declarations.push(row);
    reservationSteps.push({ phase: "resources", kind: "reserve", resourceKey: row.key });
  };
  const type = (role: string, shape: NativeDeclaredType) =>
    add({ key: key(role), role: ["delay-combinator", role], space: "type", shape });
  const fn = (role: string, name: string, signature: NativeDeclaredSignature) =>
    add({ key: key(role), role: ["delay-combinator", role], space: "function", name, signature });
  const intern = (signature: NativeDeclaredSignature, name?: string) =>
    reservationSteps.push({
      phase: "resources",
      kind: "intern-signature",
      signature,
      ...(name === undefined ? {} : { name }),
    });
  const ref = (typeKey: string) => ({ kind: "ref" as const, typeKey });
  if (r.delay) {
    const shape = createNativeDelayCaptureShape(ref(dependencies.delayWrapperKey!), ref(dependencies.promiseTypeKey));
    type("delay-capture", { ...shape, kind: "struct", parent: { kind: "resource", typeKey: shape.parent.typeKey } });
    fn("delay-callback", "__ir_promise_delay_timer_callback", lifted!);
    const sig = { params: [F64, F64], results: [EXTERN] };
    intern(sig, "$__ir_promise_delay_native_type");
    fn("delay-provider", IR_NATIVE_PROMISE_DELAY_FN, sig);
  }
  if (r.all) {
    type("all-state", {
      kind: "struct",
      ...createNativeCombinatorStateShape(ref(dependencies.promiseTypeKey), ref(dependencies.vectorArrayKey)),
    });
    type("all-element", { kind: "struct", ...createNativeCombinatorElementShape(ref(key("all-state"))) });
    const reaction = { params: [EXTERN, EXTERN], results: [EXTERN] };
    const subscribe = {
      params: [EXTERN, EXTERN, { kind: "i32" as const }, { kind: "funcref" as const }, { kind: "funcref" as const }],
      results: [],
    };
    intern(reaction);
    intern(subscribe);
    fn("subscribe", "__combinator_subscribe", subscribe);
    fn("all-fulfill", "__combinator_all_fulfill", reaction);
    fn("race-fulfill", "__combinator_race_fulfill", reaction);
    fn("reject", "__combinator_reject", reaction);
    const sig = { params: [{ kind: "ref_null" as const, typeKey: dependencies.vectorCarrierKey }], results: [EXTERN] };
    intern(sig);
    fn("all-provider", IR_ASYNC_PROMISE_ALL_NATIVE_FN, sig);
  }
  const result = { key: r.key, dependencies, declarations, reservationSteps };
  preflightNativeResourceRecipe(result, [
    ...new Set([
      dependencies.closureRootKey,
      dependencies.settleMetadataKey,
      dependencies.promiseTypeKey,
      dependencies.vectorCarrierKey,
      dependencies.vectorArrayKey,
      ...(dependencies.delayWrapperKey ? [dependencies.delayWrapperKey] : []),
    ]),
  ]);
  return freezeNativeResourceRecipe(result);
}

function authenticateDependencies(
  tx: PhysicalModuleReservations,
  r: NativeDelayCombinatorRequirements,
  d: NativeDelayCombinatorReservationDependencies,
  plan: NativeDelayCombinatorDeclarationPlan,
) {
  nativeClosureReservationInventory(tx, d.closures, d.closurePlan);
  nativePromiseReservationInventory(tx, d.promises, d.promisePlan);
  // Mandatory existing-owner association check; recipe equality cannot replace it.
  assertNativePromiseResourcePlanFor(tx, d.promises, d.promisePlan, r.promiseRequirements);
  const layout = resolveNativeVectorForElement(d.vectors, EXTERN);
  const vector = unique(
    d.vectors.layouts.filter((row) => row.layout === layout),
    "missing exact vector layout",
  );
  if (!d.vectors.base) fail("missing vector base");
  // Reject a foreign producer before a ledger assertion can poison the transaction.
  if (d.promises.types.arguments !== vector.array) fail("substituted shared Promise array");
  for (const token of [d.vectors.base, vector.array, vector.carrier]) {
    if (tx.state === "reserving") tx.assertTypeReservation(token);
    else tx.physicalIndex(token);
  }
  same(
    declareNativeDelayCombinatorResources(r, {
      closurePlan: d.closurePlan,
      promisePlan: d.promisePlan,
      vectorCarrierKey: vector.carrier.key,
      vectorArrayKey: vector.array.key,
    }),
    plan,
    "changed B3 recipe",
  );
  const metadata = unique(
    d.closures.metadata.filter((row) => row.id === r.requests.settleMetadataRequestId),
    "missing issued settle metadata",
  );
  if (
    metadata.binding.type.key !== plan.dependencies.settleMetadataKey ||
    d.closures.root.key !== plan.dependencies.closureRootKey ||
    d.promises.types.promise.key !== plan.dependencies.promiseTypeKey
  )
    fail("wrong borrowed producer keys");
  const tokens = [d.closures.root, metadata.binding.type, d.promises.types.promise, vector.carrier, vector.array];
  if (r.delay) {
    const binding = unique(
      d.closures.signatures.filter((row) => row.id === r.requests.delaySignatureRequestId),
      "missing issued delay binding",
    ).binding;
    // A prior ordinary zero-argument cache row may make hostOneShotOnly false.
    // The closure owner authenticates that observation; do not invent a fresh row.
    if (
      binding.type.key !== plan.dependencies.delayWrapperKey ||
      binding.liftedSelfTypeIndex !== d.closures.root.typeIndex
    )
      fail("wrong issued delay signature");
    tokens.push(binding.type);
  }
  return new Map(tokens.map((token) => [token.key, token]));
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly requirements: NativeDelayCombinatorRequirements;
  readonly dependencies: NativeDelayCombinatorReservationDependencies;
  readonly retainedDependencies: NativeDelayCombinatorReservationDependencies;
  readonly plan: NativeDelayCombinatorDeclarationPlan;
  readonly snapshot: unknown;
  readonly rows: readonly NativeDeclaredReservation[];
  readonly descriptors: readonly unknown[];
}
const owners = new WeakMap<NativeDelayCombinatorReservations, Owner>();

/** Validates producer/ledger ownership, not complete program source admission. No bodies are filled. */
export function reserveNativeDelayCombinatorResources(
  tx: PhysicalModuleReservations,
  requirements: NativeDelayCombinatorRequirements,
  dependencies: NativeDelayCombinatorReservationDependencies,
  expectedPlan: NativeDelayCombinatorDeclarationPlan,
): NativeDelayCombinatorReservations {
  if (tx.state !== "reserving") fail("reservation phase required");
  const tokens = authenticateDependencies(tx, requirements, dependencies, expectedPlan);
  const snapshot = freezePreparedIrValue([requirements, expectedPlan]);
  const records = executeNativeResourceRecipe(tx, expectedPlan, tokens);
  const type = (role: string) => requireNativeDeclaredReservation(records, requirements.key + ":" + role, "type");
  const fn = (role: string) => requireNativeDeclaredReservation(records, requirements.key + ":" + role, "function");
  const pack = Object.freeze({
    ...(requirements.delay
      ? {
          delay: Object.freeze({
            capture: type("delay-capture"),
            callback: fn("delay-callback"),
            provider: fn("delay-provider"),
          }),
        }
      : {}),
    ...(requirements.all
      ? {
          all: Object.freeze({
            state: type("all-state"),
            element: type("all-element"),
            subscribe: fn("subscribe"),
            allFulfill: fn("all-fulfill"),
            raceFulfill: fn("race-fulfill"),
            reject: fn("reject"),
            provider: fn("all-provider"),
          }),
        }
      : {}),
  });
  const rows = Object.freeze(expectedPlan.declarations.map((row) => records.get(row.key)!));
  owners.set(pack, {
    tx,
    requirements,
    dependencies,
    retainedDependencies: { ...dependencies },
    plan: expectedPlan,
    snapshot,
    rows,
    descriptors: rows.map((row) => freezePreparedIrValue(row.object)),
  });
  return pack;
}

/** Connect checked parent inputs to this pack's existing private owner. */
export function assertNativeDelayCombinatorReservationInputFor(
  tx: PhysicalModuleReservations,
  pack: NativeDelayCombinatorReservations,
  expectedPlan: NativeDelayCombinatorDeclarationPlan,
  expectedRequirements: NativeDelayCombinatorRequirements,
  expectedDependencies: NativeDelayCombinatorReservationDependencies,
): void {
  nativeDelayCombinatorReservationInventory(tx, pack, expectedPlan);
  const owner = owners.get(pack)!;
  same(owner.requirements, expectedRequirements, "reservation source requirements differ from checked inputs");
  if (
    owner.requirements.demands.program !== expectedRequirements.demands.program ||
    owner.requirements.demands.projection !== expectedRequirements.demands.projection
  )
    fail("detached reservation source association");
  const retained = owner.requirements.demands,
    expected = expectedRequirements.demands;
  if (
    retained.allocations !== expected.allocations ||
    expected.owners.some(
      (row, index) =>
        row.programFunction !== retained.owners[index]?.programFunction ||
        row.projectedFunction !== retained.owners[index]?.projectedFunction,
    ) ||
    expected.buffers.some((row, index) => row.instructions !== retained.buffers[index]?.instructions) ||
    expected.occurrences.some((row, index) => row.instruction !== retained.occurrences[index]?.instruction)
  )
    fail("detached borrowed census association");
  expected.literals.forEach((row, index) => {
    const prior = retained.literals[index];
    if (row.kind !== "string.const" || prior?.kind !== "string.const") return;
    const actual = row.allocation,
      previous = prior.allocation;
    if (
      (actual.metadataRow.present &&
        (!previous.metadataRow.present || actual.metadataRow.value !== previous.metadataRow.value)) ||
      (actual.encoding.present &&
        (!previous.encoding.present || !Object.is(actual.encoding.value, previous.encoding.value)))
    )
      fail("detached borrowed census association");
  });
  for (const key of ["closures", "closurePlan", "promises", "promisePlan", "vectors"] as const)
    if (owner.retainedDependencies[key] !== expectedDependencies[key])
      fail("substituted reservation producer association");
}

/** Reservation currentness only; unfilled function bodies still prevent module sealing. */
export function nativeDelayCombinatorReservationInventory(
  tx: PhysicalModuleReservations,
  pack: NativeDelayCombinatorReservations,
  expectedPlan: NativeDelayCombinatorDeclarationPlan,
): readonly NativeDeclaredReservation[] {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx || owner.plan !== expectedPlan) fail("foreign/copied pack or substituted plan");
  for (const key of ["closures", "closurePlan", "promises", "promisePlan", "vectors"] as const)
    if (owner.dependencies[key] !== owner.retainedDependencies[key]) fail("changed dependency identity");
  same([owner.requirements, owner.plan], owner.snapshot, "stale requirements/plan");
  authenticateDependencies(tx, owner.requirements, owner.dependencies, owner.plan);
  owner.rows.forEach((row, index) => {
    if (tx.state === "reserving") {
      if (row.kind === "type") tx.assertTypeReservation(row);
    } else tx.physicalIndex(row);
    same(row.object, owner.descriptors[index], "changed owned reservation descriptor");
  });
  return owner.rows;
}
