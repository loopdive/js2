// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../../../wasm/model/instructions.js";
import type { PhysicalModuleReservations } from "../../../wasm/physical/module-reservations.js";
import { preparedIrDataMismatch } from "../../../ir/program/data.js";
import {
  assertNativePrototypeRequirementsCurrent,
  type NativePrototypeRequirements,
} from "../../../ir/program/native-prototype-requirements.js";
import {
  nativeObjectDescriptorReservationInventory,
  requireCompletedNativeObjectDescriptors,
  type NativeObjectDescriptorDependencies,
  type NativeObjectDescriptorReservations,
} from "./native-object-descriptors.js";
import {
  buildPrototypeSeedAccessorTail,
  buildPrototypeSeedDataTail,
  PROTOTYPE_SEED_FLAGS,
} from "../../../runtime/wasmgc/values/prototype-seeder-bodies.js";

export interface NativePrototypeSeederBindingDependencies {
  readonly descriptors: NativeObjectDescriptorReservations;
  readonly descriptorDependencies: NativeObjectDescriptorDependencies;
}

/** The descriptor prerequisite only; no constructor/member or whole-seeder authority. */
export interface NativePrototypeSeederBindings {
  readonly requirements: NativePrototypeRequirements;
  readonly gaps: NativePrototypeRequirements["gaps"];
  readonly completionScope: "descriptor-bindings";
}

type Inventory = ReturnType<typeof nativeObjectDescriptorReservationInventory>;
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly requirements: NativePrototypeRequirements;
  readonly dependencies: NativePrototypeSeederBindingDependencies;
  readonly identities: NativePrototypeSeederBindingDependencies;
  readonly inventory: Inventory;
}
const owners = new WeakMap<NativePrototypeSeederBindings, Owner>();
function fail(detail: string): never {
  throw new Error("native prototype seeder bindings: " + detail);
}

function requireDependencies(
  tx: PhysicalModuleReservations,
  requirements: NativePrototypeRequirements,
  dependencies: NativePrototypeSeederBindingDependencies,
): Inventory {
  assertNativePrototypeRequirementsCurrent(requirements);
  if (requirements.builtins.length === 0) fail("no demanded builtin prototype");
  if (requirements.access !== dependencies.descriptorDependencies.access) fail("different access requirement identity");
  const inventory = nativeObjectDescriptorReservationInventory(
    tx,
    dependencies.descriptors,
    dependencies.descriptorDependencies,
  );
  // These are the actual issued internal functions, never the public void wrappers.
  const ext = { kind: "externref" } as const;
  for (const [index, arity, role] of [
    [0, 3, "data-body"],
    [1, 4, "accessor-body"],
  ] as const) {
    const declaration = inventory.plan.declarations[index];
    if (
      declaration?.space !== "function" ||
      !inventory.functions[index] ||
      preparedIrDataMismatch(declaration.role, ["ordinary-descriptor", role]) !== undefined ||
      preparedIrDataMismatch(declaration.signature, {
        params: [...Array.from({ length: arity }, () => ext), { kind: "f64" }],
        results: [ext],
      }) !== undefined
    )
      fail("incompatible canonical return-target descriptor ABI");
  }
  return inventory;
}

/** Bind already reserved real resources. This does not reserve a placeholder seeder. */
export function bindNativePrototypeSeederResources(
  tx: PhysicalModuleReservations,
  requirements: NativePrototypeRequirements,
  dependencies: NativePrototypeSeederBindingDependencies,
): NativePrototypeSeederBindings {
  if (tx.state !== "reserving") fail("invalid binding phase");
  const inventory = requireDependencies(tx, requirements, dependencies);
  const pack = Object.freeze({
    requirements,
    gaps: requirements.gaps,
    completionScope: "descriptor-bindings" as const,
  });
  owners.set(pack, {
    tx,
    requirements,
    dependencies,
    identities: Object.freeze({ ...dependencies }),
    inventory,
  });
  return pack;
}

export function requireNativePrototypeSeederBindings(
  tx: PhysicalModuleReservations,
  pack: NativePrototypeSeederBindings,
  expectedRequirements: NativePrototypeRequirements,
  expectedDependencies: NativePrototypeSeederBindingDependencies,
): NativePrototypeSeederBindings {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied binding");
  if (owner.requirements !== expectedRequirements || owner.dependencies !== expectedDependencies)
    fail("foreign expected requirements or dependencies");
  if (
    owner.dependencies.descriptors !== owner.identities.descriptors ||
    owner.dependencies.descriptorDependencies !== owner.identities.descriptorDependencies
  )
    fail("substituted dependency identity");
  const inventory = requireDependencies(tx, owner.requirements, owner.dependencies);
  if (inventory.plan !== owner.inventory.plan || inventory.functions !== owner.inventory.functions)
    fail("substituted canonical descriptor inventory");
  return pack;
}

export type NativePrototypeSeedDescriptor =
  | { readonly kind: "constructor" | "string-data" | "number-data" | "symbol-tag" | "getter" | "accessor-pair" }
  | { readonly kind: "method"; readonly member: string };

type CopiedDescriptor = { readonly kind: "data"; readonly flags: number } | { readonly kind: "accessor" };
function copyDescriptor(descriptor: NativePrototypeSeedDescriptor): CopiedDescriptor {
  if (descriptor === null || typeof descriptor !== "object") fail("invalid descriptor data");
  const prototype = Object.getPrototypeOf(descriptor);
  if (prototype !== Object.prototype && prototype !== null) fail("non-plain descriptor data");
  const fields = Object.getOwnPropertyDescriptors(descriptor);
  for (const key of Reflect.ownKeys(fields))
    if (typeof key !== "string" || !Object.hasOwn(fields[key]!, "value")) fail("non-data descriptor field");
  const kind = Object.hasOwn(fields, "kind") ? fields.kind!.value : undefined;
  let copied: CopiedDescriptor;
  switch (kind) {
    case "getter":
    case "accessor-pair":
      copied = { kind: "accessor" };
      break;
    case "constructor":
    case "string-data":
      copied = { kind: "data", flags: PROTOTYPE_SEED_FLAGS.method };
      break;
    case "number-data":
      copied = { kind: "data", flags: PROTOTYPE_SEED_FLAGS.constant };
      break;
    case "symbol-tag":
      copied = { kind: "data", flags: PROTOTYPE_SEED_FLAGS.symbolTag };
      break;
    case "method": {
      const member = Object.hasOwn(fields, "member") ? fields.member!.value : undefined;
      if (typeof member !== "string" || member.length === 0) fail("missing method spelling");
      copied = {
        kind: "data",
        flags: member === "@@3" ? PROTOTYPE_SEED_FLAGS.symbolTag : PROTOTYPE_SEED_FLAGS.method,
      };
      break;
    }
    default:
      return fail("unknown descriptor family");
  }
  if (Reflect.ownKeys(fields).some((key) => key !== "kind" && !(kind === "method" && key === "member")))
    fail("unexpected descriptor field");
  return Object.freeze(copied);
}
function copyDescriptors(descriptors: readonly NativePrototypeSeedDescriptor[]): readonly CopiedDescriptor[] {
  if (!Array.isArray(descriptors) || Object.getPrototypeOf(descriptors) !== Array.prototype)
    fail("invalid descriptor batch");
  const fields = Object.getOwnPropertyDescriptors(descriptors as object);
  const length = Object.hasOwn(fields, "length") ? fields.length!.value : undefined;
  if (!Number.isInteger(length) || length <= 0) fail("empty or invalid descriptor batch");
  if (Reflect.ownKeys(fields).length !== length + 1) fail("sparse or extended descriptor batch");
  const copied: CopiedDescriptor[] = [];
  for (let index = 0; index < length; index++) {
    const key = String(index),
      field = Object.hasOwn(fields, key) ? fields[key] : undefined;
    if (!field || !Object.hasOwn(field, "value")) fail("non-data descriptor batch entry");
    copied.push(copyDescriptor(field.value));
  }
  return Object.freeze(copied);
}

/**
 * Copy all construction data before checking current authority. One synchronous
 * batch authenticates the complete descriptor graph once; a later batch must
 * revalidate it. No caller-owned data or callbacks are read after authentication.
 * These tails grant no operand or whole-prototype completeness authority.
 */
export function buildNativePrototypeSeedDescriptorTails(
  tx: PhysicalModuleReservations,
  pack: NativePrototypeSeederBindings,
  expectedRequirements: NativePrototypeRequirements,
  expectedDependencies: NativePrototypeSeederBindingDependencies,
  descriptors: readonly NativePrototypeSeedDescriptor[],
): Instr[][] {
  const copied = copyDescriptors(descriptors);
  requireNativePrototypeSeederBindings(tx, pack, expectedRequirements, expectedDependencies);
  requireCompletedNativeObjectDescriptors(
    tx,
    expectedDependencies.descriptors,
    expectedDependencies.descriptorDependencies,
  );
  const functions = owners.get(pack)!.inventory.functions;
  return copied.map((descriptor) =>
    descriptor.kind === "accessor"
      ? buildPrototypeSeedAccessorTail(functions[1]!.handle)
      : buildPrototypeSeedDataTail(functions[0]!.handle, descriptor.flags),
  );
}

/** Single-tail compatibility API with the same fresh ownership/completion checks. */
export function buildNativePrototypeSeedDescriptorTail(
  tx: PhysicalModuleReservations,
  pack: NativePrototypeSeederBindings,
  expectedRequirements: NativePrototypeRequirements,
  expectedDependencies: NativePrototypeSeederBindingDependencies,
  descriptor: NativePrototypeSeedDescriptor,
): Instr[] {
  return buildNativePrototypeSeedDescriptorTails(tx, pack, expectedRequirements, expectedDependencies, [
    descriptor,
  ])[0]!;
}
