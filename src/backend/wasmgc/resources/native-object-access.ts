// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FunctionReservation, PhysicalModuleReservations } from "../../../wasm/physical/module-reservations.js";
import type { NativeResourceRecipe } from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import { preparedIrDataMismatch } from "../../../ir/program/data.js";
import {
  buildOrdinaryObjectHashDefinition,
  buildOrdinaryObjectKeyEqualsDefinition,
  buildOrdinaryObjectFindDefinition,
} from "../../../runtime/wasmgc/values/ordinary-object-key-definitions.js";
import {
  buildOrdinaryObjectLookupDefinition,
  buildOrdinaryObjectHasDefinition,
  ORDINARY_OBJECT_READ_ENCODING,
} from "../../../runtime/wasmgc/values/ordinary-object-access-bodies.js";
import {
  requireNativeObjectLayouts,
  type NativeObjectLayoutDeclarationPlan,
  type NativeObjectLayoutReservations,
} from "./native-object-layouts.js";
import {
  nativeStringLiteralReservationInventory,
  nativeStringTypeKeys,
  type NativeStringLiteralReservations,
} from "./native-string-literals.js";
import {
  requireNativeStringFlattenReservations,
  type NativeStringFlattenReservations,
} from "./native-string-flatten.js";
import {
  requireNativeStringEqualityReservations,
  requireCompletedNativeStringEquality,
  type NativeStringEqualityReservations,
} from "./native-string-equality.js";
import {
  requireNativeSymbolCarrierReservations,
  requireCompletedNativeSymbolCarrier,
  type NativeSymbolCarrierReservations,
} from "./native-symbol-carrier.js";
import { declareNativeObjectLookupResources } from "./native-object-access-declarations.js";
import { executeNativeResourceRecipe, requireNativeDeclaredReservation } from "./native-resource-declarations.js";

export interface NativeObjectLookupDependencies {
  readonly layouts: NativeObjectLayoutReservations;
  readonly layoutPlan: NativeObjectLayoutDeclarationPlan;
  readonly strings: NativeStringLiteralReservations;
  readonly flatten: NativeStringFlattenReservations;
  readonly equality: NativeStringEqualityReservations;
  readonly symbols: NativeSymbolCarrierReservations;
}
export interface NativeObjectLookupReservations {
  readonly hash: FunctionReservation;
  readonly keyEquals: FunctionReservation;
  readonly findOwn: FunctionReservation;
  readonly lookup: FunctionReservation;
  readonly has: FunctionReservation;
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly key: string;
  readonly dependencies: NativeObjectLookupDependencies;
  readonly identities: NativeObjectLookupDependencies;
  readonly sourcePlan: NativeResourceRecipe;
  readonly recipe: NativeResourceRecipe;
  readonly pack: NativeObjectLookupReservations;
  readonly tokens: readonly FunctionReservation[];
  filled: boolean;
}
const owners = new WeakMap<NativeObjectLookupReservations, Owner>();
function fail(detail: string): never {
  throw new Error("native object lookup: " + detail);
}
function requireDependencies(tx: PhysicalModuleReservations, d: NativeObjectLookupDependencies): void {
  requireNativeObjectLayouts(tx, d.layouts, d.layoutPlan);
  nativeStringLiteralReservationInventory(tx, d.strings);
  requireNativeStringFlattenReservations(tx, d.flatten);
  requireNativeStringEqualityReservations(tx, d.equality, d.strings);
  requireNativeSymbolCarrierReservations(tx, d.symbols, d.strings);
  if (d.flatten.stringPack !== d.strings || d.equality.flattenPack !== d.flatten)
    fail("substituted shared string/flatten dependency");
}
function declaration(key: string, tx: PhysicalModuleReservations, d: NativeObjectLookupDependencies) {
  const { typePack } = nativeStringLiteralReservationInventory(tx, d.strings);
  return declareNativeObjectLookupResources(key, {
    object: d.layouts.object.key,
    propEntry: d.layouts.propEntry.key,
    nativeString: nativeStringTypeKeys(typePack.key).flat,
  });
}
function requireOwner(tx: PhysicalModuleReservations, pack: NativeObjectLookupReservations): Owner {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied owner");
  for (const role of Object.keys(owner.identities) as (keyof NativeObjectLookupDependencies)[]) {
    if (owner.dependencies[role] !== owner.identities[role]) fail("substituted dependency identity");
  }
  requireDependencies(tx, owner.dependencies);
  if (
    preparedIrDataMismatch(owner.sourcePlan, owner.recipe) !== undefined ||
    preparedIrDataMismatch(declaration(owner.key, tx, owner.dependencies), owner.recipe) !== undefined
  )
    fail("changed declaration plan");
  const current = [pack.hash, pack.keyEquals, pack.findOwn, pack.lookup, pack.has];
  if (owner.tokens.some((token, index) => token !== current[index])) fail("substituted function token");
  if (tx.state !== "reserving") owner.tokens.forEach((token) => tx.physicalIndex(token));
  return owner;
}

/** Canonical five-function key/lookup subgraph, not generic Get/Has acceptance. */
export function reserveNativeObjectLookupResources(
  tx: PhysicalModuleReservations,
  key: string,
  dependencies: NativeObjectLookupDependencies,
  expectedPlan: NativeResourceRecipe,
): NativeObjectLookupReservations {
  if (tx.state !== "reserving" || typeof key !== "string" || !key) fail("invalid reservation phase/key");
  requireDependencies(tx, dependencies);
  const recipe = declaration(key, tx, dependencies);
  if (preparedIrDataMismatch(expectedPlan, recipe) !== undefined) fail("substituted declaration plan");
  tx.assertReservationKeysAvailable(recipe.declarations.map((row) => row.key));
  const { typePack } = nativeStringLiteralReservationInventory(tx, dependencies.strings);
  const types = new Map(
    [...typePack.types, dependencies.layouts.object, dependencies.layouts.propEntry].map((token) => [token.key, token]),
  );
  const records = executeNativeResourceRecipe(tx, recipe, types);
  const pack = Object.freeze({
    hash: requireNativeDeclaredReservation(records, key + ":hash", "function"),
    keyEquals: requireNativeDeclaredReservation(records, key + ":key-equals", "function"),
    findOwn: requireNativeDeclaredReservation(records, key + ":find-own", "function"),
    lookup: requireNativeDeclaredReservation(records, key + ":lookup", "function"),
    has: requireNativeDeclaredReservation(records, key + ":has", "function"),
  });
  owners.set(pack, {
    tx,
    key,
    dependencies,
    identities: Object.freeze({ ...dependencies }),
    sourcePlan: expectedPlan,
    recipe,
    pack,
    tokens: Object.freeze([pack.hash, pack.keyEquals, pack.findOwn, pack.lookup, pack.has]),
    filled: false,
  });
  return pack;
}

export function requireNativeObjectLookupReservations(
  tx: PhysicalModuleReservations,
  pack: NativeObjectLookupReservations,
  expectedDependencies: NativeObjectLookupDependencies,
): NativeObjectLookupReservations {
  if (requireOwner(tx, pack).dependencies !== expectedDependencies) fail("foreign expected dependencies");
  return pack;
}

export function fillNativeObjectLookupResources(
  tx: PhysicalModuleReservations,
  pack: NativeObjectLookupReservations,
): void {
  const owner = requireOwner(tx, pack);
  if (tx.state !== "filling" || owner.filled) fail("invalid phase or duplicate canonical fill");
  const d = owner.dependencies;
  requireCompletedNativeStringEquality(tx, d.equality, d.strings);
  requireCompletedNativeSymbolCarrier(tx, d.symbols, d.strings);
  const keys = {
    anyStrTypeIdx: d.strings.layout.anyStrTypeIdx,
    nativeStrTypeIdx: d.strings.layout.nativeStrTypeIdx,
    nativeStrRef: { kind: "ref" as const, typeIdx: d.strings.layout.nativeStrTypeIdx },
    strDataTypeIdx: d.strings.layout.nativeStrDataTypeIdx,
    symbolTypeIdx: d.symbols.types.symbol.typeIndex,
    symbolKeysEnabled: true,
    strFlattenIdx: d.flatten.flatten.handle,
    strEqualsIdx: d.equality.equals.handle,
  };
  tx.fillFunction(
    pack.hash,
    buildOrdinaryObjectHashDefinition({
      ...keys,
      hashedStrTypeIdx: d.strings.layout.hashedStrTypeIdx,
      nativeFirst: true,
    }),
  );
  tx.fillFunction(pack.keyEquals, buildOrdinaryObjectKeyEqualsDefinition(keys));
  tx.fillFunction(
    pack.findOwn,
    buildOrdinaryObjectFindDefinition({
      ...keys,
      objectTypeIdx: d.layouts.object.typeIndex,
      propMapTypeIdx: d.layouts.propMap.typeIndex,
      propEntryTypeIdx: d.layouts.propEntry.typeIndex,
      keyEqualsIdx: pack.keyEquals.handle,
      objHashIdx: pack.hash.handle,
      tombstoneFlag: ORDINARY_OBJECT_READ_ENCODING.tombstone,
    }),
  );
  tx.fillFunction(
    pack.lookup,
    buildOrdinaryObjectLookupDefinition({
      objectTypeIdx: d.layouts.object.typeIndex,
      propEntryTypeIdx: d.layouts.propEntry.typeIndex,
      findOwnIdx: pack.findOwn.handle,
    }),
  );
  tx.fillFunction(pack.has, buildOrdinaryObjectHasDefinition(pack.lookup.handle));
  owner.filled = true;
}

export function requireCompletedNativeObjectLookup(
  tx: PhysicalModuleReservations,
  pack: NativeObjectLookupReservations,
  expectedDependencies: NativeObjectLookupDependencies,
): NativeObjectLookupReservations {
  requireNativeObjectLookupReservations(tx, pack, expectedDependencies);
  const owner = owners.get(pack)!;
  if (!owner.filled) fail("missing canonical fill");
  requireCompletedNativeStringEquality(tx, owner.dependencies.equality, owner.dependencies.strings);
  requireCompletedNativeSymbolCarrier(tx, owner.dependencies.symbols, owner.dependencies.strings);
  owner.tokens.forEach((token) => tx.assertCompletedReservation(token));
  return pack;
}

export function nativeObjectLookupReservationInventory(
  tx: PhysicalModuleReservations,
  pack: NativeObjectLookupReservations,
) {
  const owner = requireOwner(tx, pack);
  return Object.freeze({ key: owner.key, plan: owner.recipe, functions: owner.tokens });
}
