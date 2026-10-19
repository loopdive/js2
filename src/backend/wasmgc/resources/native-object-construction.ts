// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FunctionReservation, PhysicalModuleReservations } from "../../../wasm/physical/module-reservations.js";
import type { Instr } from "../../../wasm/model/instructions.js";
import type {
  NativeDeclaredValType,
  NativeResourceRecipe,
} from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import { buildBoxBooleanBody } from "../../../runtime/wasmgc/values/boolean-bodies.js";
import { buildNativeObjectConstructionDefinition } from "../../../runtime/wasmgc/values/object-construction-definition.js";
import {
  assertNativeObjectConstructionRequirementsCurrent,
  type NativeObjectConstructionRequirements,
  type NativeObjectConstructionDemand,
} from "../../../ir/program/native-object-construction-requirements.js";
import { preparedIrDataMismatch } from "../../../ir/program/data.js";
import {
  requireNativeObjectDescriptorReservations,
  requireCompletedNativeObjectDescriptors,
  type NativeObjectDescriptorReservations,
  type NativeObjectDescriptorDependencies,
} from "./native-object-descriptors.js";
import { requireNativeStringLiteral } from "./native-string-literals.js";
import {
  executeNativeResourceRecipe,
  freezeNativeResourceRecipe,
  requireNativeDeclaredReservation,
} from "./native-resource-declarations.js";

export interface NativeObjectConstructionDependencies {
  readonly descriptors: NativeObjectDescriptorReservations;
  readonly descriptorDependencies: NativeObjectDescriptorDependencies;
}
export interface NativeObjectConstructionReservations {
  readonly initialize: FunctionReservation;
  readonly completionScope: "explicit-prototype-initialization-prerequisite";
}
function fail(detail: string): never {
  throw Error("native object construction: " + detail);
}
export function declareNativeObjectConstructionResources(
  key: string,
  demand: NativeObjectConstructionDemand,
  objectTypeKey: string,
  stringTypeKey: string,
): NativeResourceRecipe {
  if (!key || !objectTypeKey || !stringTypeKey) fail("invalid declaration key/type");
  const ext = { kind: "externref" } as const;
  const params: NativeDeclaredValType[] = [{ kind: "ref_null", typeKey: objectTypeKey }];
  for (const carrier of demand.carriers) {
    switch (carrier) {
      case "number":
        params.push({ kind: "f64" });
        break;
      case "boolean":
        params.push({ kind: "i32" });
        break;
      case "native-string":
        params.push({ kind: "ref", typeKey: stringTypeKey });
        break;
      case "live-reference":
        params.push(ext);
        break;
      default:
        fail("unknown field carrier");
    }
  }
  const declarations = [
    {
      key: key + ":initialize",
      role: ["ordinary-construction", demand.key],
      space: "function" as const,
      name: "__ordinary_object_initialize",
      signature: { params, results: [ext] },
    },
  ];
  if (demand.carriers.includes("boolean"))
    declarations.push({
      key: key + ":box-boolean",
      role: ["ordinary-construction", "box-boolean"],
      space: "function",
      name: "__ordinary_object_box_boolean",
      signature: { params: [{ kind: "i32" }], results: [ext] },
    });
  return freezeNativeResourceRecipe({
    declarations,
    reservationSteps: declarations.map((row) => ({ phase: "resources", kind: "reserve", resourceKey: row.key })),
  });
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly key: string;
  readonly requirements: NativeObjectConstructionRequirements;
  readonly index: number;
  readonly dependencies: NativeObjectConstructionDependencies;
  readonly identities: NativeObjectConstructionDependencies;
  readonly sourcePlan: NativeResourceRecipe;
  readonly recipe: NativeResourceRecipe;
  readonly tokens: readonly FunctionReservation[];
  filled: boolean;
}
const owners = new WeakMap<NativeObjectConstructionReservations, Owner>();
function selected(requirements: NativeObjectConstructionRequirements, index: number) {
  assertNativeObjectConstructionRequirementsCurrent(requirements);
  const demand = requirements.constructors[index];
  if (!Number.isSafeInteger(index) || index < 0 || !demand) fail("missing actual selected constructor");
  return demand;
}
function dependencies(
  tx: PhysicalModuleReservations,
  requirements: NativeObjectConstructionRequirements,
  d: NativeObjectConstructionDependencies,
) {
  requireNativeObjectDescriptorReservations(tx, d.descriptors, d.descriptorDependencies);
  if (d.descriptorDependencies.access !== requirements.access) fail("foreign source/property requirement owner");
  const lookup = d.descriptorDependencies.storageDependencies.lookupDependencies;
  const stringType = lookup.strings.types.find((token) => token.typeIndex === lookup.strings.layout.anyStrTypeIdx);
  if (!stringType) fail("missing issued native string type");
  return { lookup, stringType };
}
function recipeFor(
  tx: PhysicalModuleReservations,
  key: string,
  requirements: NativeObjectConstructionRequirements,
  index: number,
  d: NativeObjectConstructionDependencies,
) {
  const demand = selected(requirements, index),
    { lookup, stringType } = dependencies(tx, requirements, d);
  demand.keys.forEach((key) => requireNativeStringLiteral(tx, lookup.strings, key));
  return {
    recipe: declareNativeObjectConstructionResources(key, demand, lookup.layouts.object.key, stringType.key),
    lookup,
    stringType,
  };
}
function requireOwner(tx: PhysicalModuleReservations, pack: NativeObjectConstructionReservations): Owner {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied owner");
  if (
    owner.dependencies.descriptors !== owner.identities.descriptors ||
    owner.dependencies.descriptorDependencies !== owner.identities.descriptorDependencies
  )
    fail("substituted dependency identity");
  const current = recipeFor(tx, owner.key, owner.requirements, owner.index, owner.dependencies).recipe;
  if (
    preparedIrDataMismatch(owner.sourcePlan, owner.recipe) !== undefined ||
    preparedIrDataMismatch(current, owner.recipe) !== undefined
  )
    fail("changed construction declaration plan");
  if (pack.initialize !== owner.tokens[0] || pack.completionScope !== "explicit-prototype-initialization-prerequisite")
    fail("substituted constructor token/scope");
  if (tx.state !== "reserving") owner.tokens.forEach((token) => tx.physicalIndex(token));
  return owner;
}
export function reserveNativeObjectConstructionResources(
  tx: PhysicalModuleReservations,
  key: string,
  requirements: NativeObjectConstructionRequirements,
  index: number,
  d: NativeObjectConstructionDependencies,
  expectedPlan: NativeResourceRecipe,
): NativeObjectConstructionReservations {
  if (tx.state !== "reserving") fail("invalid reservation phase");
  const { recipe, lookup, stringType } = recipeFor(tx, key, requirements, index, d);
  if (preparedIrDataMismatch(expectedPlan, recipe) !== undefined) fail("substituted declaration plan");
  tx.assertReservationKeysAvailable(recipe.declarations.map((row) => row.key));
  const records = executeNativeResourceRecipe(
    tx,
    recipe,
    new Map([
      [lookup.layouts.object.key, lookup.layouts.object],
      [stringType.key, stringType],
    ]),
  );
  const tokens = Object.freeze(
    recipe.declarations.map((row) => requireNativeDeclaredReservation(records, row.key, "function")),
  );
  const pack = Object.freeze({
    initialize: tokens[0]!,
    completionScope: "explicit-prototype-initialization-prerequisite" as const,
  });
  owners.set(pack, {
    tx,
    key,
    requirements,
    index,
    dependencies: d,
    identities: Object.freeze({ ...d }),
    sourcePlan: expectedPlan,
    recipe,
    tokens,
    filled: false,
  });
  return pack;
}
export function requireNativeObjectConstructionReservations(
  tx: PhysicalModuleReservations,
  pack: NativeObjectConstructionReservations,
  requirements: NativeObjectConstructionRequirements,
  index: number,
  d: NativeObjectConstructionDependencies,
): NativeObjectConstructionReservations {
  const owner = requireOwner(tx, pack);
  if (owner.requirements !== requirements || owner.index !== index || owner.dependencies !== d)
    fail("foreign expected inputs");
  return pack;
}
export function fillNativeObjectConstructionResources(
  tx: PhysicalModuleReservations,
  pack: NativeObjectConstructionReservations,
): void {
  const owner = requireOwner(tx, pack),
    d = owner.dependencies.descriptorDependencies;
  if (tx.state !== "filling" || owner.filled) fail("invalid phase or duplicate canonical fill");
  requireCompletedNativeObjectDescriptors(tx, owner.dependencies.descriptors, d);
  const demand = selected(owner.requirements, owner.index),
    strings = d.storageDependencies.lookupDependencies.strings;
  const keys = demand.keys.map((key) => {
    const ref = requireNativeStringLiteral(tx, strings, key);
    return [
      ref.kind === "global"
        ? { op: "global.get", index: tx.physicalIndex(ref.global) }
        : { op: "call", funcIdx: ref.function.handle },
      { op: "extern.convert_any" },
    ] as Instr[];
  });
  // Every prerequisite is checked before filling any owned slot.
  const fields = demand.keys.map((key, sourceIndex) => {
    const field = demand.shape.fields.findIndex((row) => row.name === key);
    if (field < 0) fail("missing issued field coordinate");
    const conversion: Instr[] = [];
    switch (demand.carriers[field]) {
      case "number":
        conversion.push({ op: "call", funcIdx: d.sameValueDependencies.values.functions.boxNumber.handle });
        break;
      case "boolean":
        if (!owner.tokens[1]) fail("missing owned Boolean boxer");
        conversion.push({ op: "call", funcIdx: owner.tokens[1].handle });
        break;
      case "native-string":
        conversion.push({ op: "extern.convert_any" });
        break;
      case "live-reference":
        break;
      default:
        fail("unowned field conversion");
    }
    return { argument: field + 1, key: keys[sourceIndex]!, conversion };
  });
  const body = buildNativeObjectConstructionDefinition({
    create: d.storage.createWithPrototype.handle,
    defineData: owner.dependencies.descriptors.defineData.handle,
    parameterCount: demand.carriers.length + 1,
    fields,
  });
  if (owner.tokens[1])
    tx.fillFunction(owner.tokens[1], {
      locals: [],
      body: buildBoxBooleanBody({
        mode: "allocating",
        typeIndex: d.sameValueDependencies.values.types.boxedBoolean.typeIndex,
      }),
    });
  tx.fillFunction(pack.initialize, body);
  owner.filled = true;
}
export function requireCompletedNativeObjectConstruction(
  tx: PhysicalModuleReservations,
  pack: NativeObjectConstructionReservations,
  requirements: NativeObjectConstructionRequirements,
  index: number,
  d: NativeObjectConstructionDependencies,
): NativeObjectConstructionReservations {
  requireNativeObjectConstructionReservations(tx, pack, requirements, index, d);
  const owner = owners.get(pack)!;
  if (!owner.filled) fail("missing canonical fill");
  requireCompletedNativeObjectDescriptors(tx, d.descriptors, d.descriptorDependencies);
  owner.tokens.forEach((token) => tx.assertCompletedReservation(token));
  return pack;
}
