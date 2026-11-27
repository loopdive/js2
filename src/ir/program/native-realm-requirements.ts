// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import {
  NATIVE_ERROR_CONSTRUCTORS,
  NATIVE_FUNCTION_PROTOTYPE_METHODS,
  NATIVE_OBJECT_PROTOTYPE_METHODS,
  NATIVE_REALM_CATALOG,
  NATIVE_VALUE_INTRINSICS,
  NATIVE_WRAPPER_CONSTRUCTORS,
  realmMethodId,
  type NativeRealmIntrinsic,
} from "../../runtime/contracts/native-realm-catalog.js";
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import { forEachInstrDeep } from "../core/nodes.js";
import { irNumberConversionCallableDeclaration } from "../runtime/number-conversion-callable.js";
import { nativeAsyncCallableValueTypes, nativeAsyncCallMismatch } from "../runtime/native-async-callables.js";
import { freezePreparedIrValue, preparedIrDataMismatch } from "./data.js";
import { issuedPacks } from "./issued-packs.js";
import type { PreparedIrProgram, PreparedIrProgramRuntimeProjection } from "./prepared-contracts.js";
import {
  deriveNativeObjectAccessRequirements,
  assertNativeObjectAccessRequirementsCurrent,
  type NativeObjectAccessRequirements,
} from "./native-object-access-requirements.js";
import {
  planNativeSourceClosureRequirements,
  type NativeSourceClosureRequirements,
} from "./native-source-closure-requirements.js";

export interface NativeRealmDescription {
  readonly key: string;
  readonly catalog: typeof NATIVE_REALM_CATALOG;
  readonly sourceUnits: readonly IrUnitId[];
  readonly sourceSignatureIds: readonly string[];
  readonly sourceAllocationOccurrences: readonly number[];
  readonly objectUses: NativeObjectAccessRequirements["uses"];
  /**
   * The function values the realm holds beyond its bootstrap pair, in `NATIVE_VALUE_INTRINSICS` order: (#7354 P1) the
   * Object.prototype methods where the program reads one ([[Get]] of its name, or the method itself), none otherwise,
   * since no other read can reach one, and (#7557) so the Function.prototype methods; (#7354 G1) the Error family where the program can observe an error
   * ({@link heldErrorConstructors}).
   */
  readonly intrinsics: readonly string[];
  readonly numberUses: readonly {
    readonly occurrence: number;
    readonly semanticOccurrence: number;
    readonly ownerUnitId: IrUnitId;
  }[];
  readonly unavailable: readonly { readonly id: string; readonly role: string }[];
  readonly completionScope: "native-realm-bootstrap";
}
export interface NativeRealmRequirements {
  readonly program: PreparedIrProgram;
  readonly projection: PreparedIrProgramRuntimeProjection;
  readonly source?: NativeSourceClosureRequirements;
  /** Actual source descriptor demands. Catalog descriptors never enter this occurrence census. */
  readonly access: NativeObjectAccessRequirements;
  readonly description: NativeRealmDescription;
}
const realmPacks = issuedPacks<NativeRealmRequirements>(() => fail("unissued, copied or detached realm requirements"));
function fail(detail: string): never {
  throw Error("native realm requirements: " + detail);
}
function same(a: unknown, b: unknown, detail: string): void {
  if (preparedIrDataMismatch(a, b) !== undefined) fail(detail);
}
type NumberCall = Extract<
  NativeObjectAccessRequirements["demands"]["occurrences"][number]["instruction"],
  { kind: "call" }
>;
interface NumberCallRow {
  readonly occurrence: number;
  readonly call: NumberCall;
  readonly declaration: NonNullable<ReturnType<typeof irNumberConversionCallableDeclaration>>;
}
function numberUses(access: NativeObjectAccessRequirements): NativeRealmDescription["numberUses"] {
  const { demands } = access;
  // One pass groups the Number conversion calls by owner and view, so the derivation is linear in the occurrences
  // rather than owners × occurrences.
  const calls = new Map<string, NumberCallRow[]>();
  const callKey = (unitId: IrUnitId, view: string) => JSON.stringify([unitId, view]);
  demands.occurrences.forEach((row, occurrence) => {
    const call = row.instruction;
    if (call.kind !== "call") return;
    const declaration = irNumberConversionCallableDeclaration(call.target);
    if (!declaration) return;
    const region = demands.buffers[row.bufferIndex]!;
    const key = callKey(region.ownerUnitId, region.view);
    const entry = { occurrence, call, declaration };
    const rows = calls.get(key);
    if (rows) rows.push(entry);
    else calls.set(key, [entry]);
  });
  return demands.owners.flatMap((owner) => {
    const rows = (view: "program" | "projection") => {
      const found = calls.get(callKey(owner.unitId, view)) ?? [];
      if (!found.length) return found;
      const types = nativeAsyncCallableValueTypes(view === "program" ? owner.programFunction : owner.projectedFunction);
      for (const { call, declaration } of found) {
        const mismatch = nativeAsyncCallMismatch(call, declaration, types);
        if (mismatch) fail("noncanonical Number callable: " + mismatch);
      }
      return found;
    };
    const semantic = rows("program"),
      projected = rows("projection");
    if (semantic.length !== projected.length) fail("Number semantic/projection population differs");
    return projected.map((row, index) => {
      const original = semantic[index]!;
      same(row.call.target.binding, original.call.target.binding, "Number binding differs across projection");
      same(row.call.site, original.call.site, "Number source site differs across projection");
      return { occurrence: row.occurrence, semanticOccurrence: original.occurrence, ownerUnitId: owner.unitId };
    });
  });
}
type Use = NativeObjectAccessRequirements["uses"][number];
/** (#7354 G1) The catalog id `js.object.intrinsic` answers for `use`, if `use` is a call of it. */
const intrinsicOf = (use: Use): string | undefined =>
  use.feature === "js.object.intrinsic" && use.selector !== undefined
    ? NATIVE_VALUE_INTRINSICS[use.selector]
    : undefined;
/**
 * (#7354 P1, #7557) The prototype methods the realm holds as a group, by name: the Object.prototype methods, and the
 * Function.prototype methods its built-in caller answers.
 */
const methodGroup = (parent: string, names: readonly string[]) => ({
  names,
  ids: names.map((name) => realmMethodId(parent, name)),
});
const METHOD_GROUPS = [
  methodGroup("Object.prototype", NATIVE_OBJECT_PROTOTYPE_METHODS),
  methodGroup("Function.prototype", NATIVE_FUNCTION_PROTOTYPE_METHODS),
];
/** `Error.prototype.toString`'s id, and the family's: the Error constructors' and it. */
const ERROR_TO_STRING = realmMethodId("Error.prototype", "toString");
/** (#7354 A1) The Array family, and the RangeError its arrays throw. */
const ARRAY_ID = "%Array%",
  RANGE_ERROR_ID = "%RangeError%";
const FAMILY_IDS: readonly string[] = [...NATIVE_ERROR_CONSTRUCTORS.map((name) => `%${name}%`), ERROR_TO_STRING];
/** (#7354 P1) A use that may reach a method of `group`: a constant key naming one, or the method itself. */
const readsGroupMethod =
  (group: (typeof METHOD_GROUPS)[number]) =>
  (use: Use): boolean =>
    group.ids.includes(intrinsicOf(use) ?? "") ||
    (use.constantKey !== undefined && group.names.includes(use.constantKey));
/** Whether some function of `program` binds a caught value: the one way a thrown error becomes a program value. */
function bindsCaughtValue(program: PreparedIrProgram): boolean {
  let binds = false;
  for (const fn of program.ir.functions)
    for (const block of fn.blocks)
      for (const root of block.instrs)
        forEachInstrDeep(root, (instr) => {
          if (instr.kind === "try" && (instr.catchClause?.payloadSlot ?? -1) >= 0) binds = true;
        });
  return binds;
}
/** (#7354 G1) The Error family's contracts: each needs the family's objects and literals. */
const ERROR_FEATURES: ReadonlySet<string> = new Set(["js.object.create-error", "js.object.error-to-string"]);
/** The family (`heldWith`) of each family row, by id. */
const FAMILY_OF: ReadonlyMap<string, string> = new Map(
  NATIVE_REALM_CATALOG.intrinsics.flatMap((row) => (row.heldWith === undefined ? [] : [[row.id, row.heldWith]])),
);
const familyOf = (id: string): string => FAMILY_OF.get(id) ?? id;
/**
 * (#7354 G1) The family members the realm holds, derived only from what the program's IR emitted. The Error family:
 * where the IR uses any member (an intrinsic read of one, `create-error`, `error-to-string`) or binds a caught value
 * (the one way a realm error becomes a program value), `Error`, `TypeError` (the realm's own errors) and
 * `Error.prototype.toString`, with every other constructor the IR reads. (#7354 W2) `Object` and a wrapper family
 * (its constructor and native methods) where the IR reads one of its values or creates its wrapper
 * (`create-wrapper`'s selector). The legalization decides what to emit; this never re-derives that decision from the
 * source, so the two cannot disagree. Where none is held no code reads one.
 */
function heldFamilyMembers(uses: readonly Use[], program: PreparedIrProgram): ReadonlySet<string> {
  const named = new Set(uses.map(intrinsicOf).filter((id): id is string => id !== undefined));
  const families = new Set([...named].map(familyOf));
  for (const use of uses) {
    if (use.feature === "js.object.create-wrapper" && use.selector !== undefined)
      families.add(`%${NATIVE_WRAPPER_CONSTRUCTORS[use.selector]}%`);
    if (use.feature === "js.object.create-array") families.add(ARRAY_ID);
  }
  const errors =
    [...named].some((id) => FAMILY_IDS.includes(id)) ||
    uses.some((use) => ERROR_FEATURES.has(use.feature)) ||
    bindsCaughtValue(program);
  // (#7354 A1) An array's `length` throws the realm's RangeError (ArraySetLength), which a caught value can be.
  const thrown = families.has(ARRAY_ID) ? [RANGE_ERROR_ID] : [];
  return new Set([
    ...(errors
      ? ["%Error%", "%TypeError%", ERROR_TO_STRING, ...FAMILY_IDS.filter((id) => named.has(id) || thrown.includes(id))]
      : []),
    ...VALUE_IDS.filter((id) => !FAMILY_IDS.includes(id) && families.has(familyOf(id))),
  ]);
}
/** The function values of {@link NATIVE_VALUE_INTRINSICS}: the realm holds each as an entry. */
const VALUE_IDS = NATIVE_VALUE_INTRINSICS.filter(
  (id) => NATIVE_REALM_CATALOG.intrinsics.find((row) => row.id === id)?.callable !== undefined,
);
/**
 * (#7354 G1) The catalog rows of the realm `description` holds: those of every realm, and of a held family its
 * objects and the function values the realm holds. (W2) A member the realm does not hold (`String.prototype.charAt`)
 * is no row of it, so its key is no property the realm seeds.
 */
export function heldCatalogRows(description: NativeRealmDescription): readonly NativeRealmIntrinsic[] {
  return description.catalog.intrinsics.filter(
    (row) =>
      row.heldWith === undefined ||
      (description.intrinsics.includes(row.heldWith) && (!row.callable || description.intrinsics.includes(row.id))),
  );
}
function calculate(
  program: PreparedIrProgram,
  projection: PreparedIrProgramRuntimeProjection,
  source: NativeSourceClosureRequirements | undefined,
  access: NativeObjectAccessRequirements,
): NativeRealmDescription | undefined {
  assertNativeObjectAccessRequirementsCurrent(access);
  if (access.demands.program !== program || access.demands.projection !== projection)
    fail("foreign access program/projection");
  if (source) {
    if (source.demands.program !== program || source.demands.projection !== projection)
      fail("foreign source program/projection");
  }
  const selectedSource =
    !!source &&
    !!(source.signatures.length || source.shapes.length || source.units.length || source.allocations.length);
  const numbers = numberUses(access);
  const held = heldFamilyMembers(access.uses, program);
  const methods = METHOD_GROUPS.flatMap((group) => (access.uses.some(readsGroupMethod(group)) ? group.ids : []));
  if (!selectedSource && !access.uses.length && !numbers.length) return undefined;
  const anchor = program.inventory.sources.find((row) => row.kind === "entry");
  if (!anchor) fail("missing prepared entry anchor");
  return {
    key: "native-realm:" + JSON.stringify(anchor.id),
    catalog: NATIVE_REALM_CATALOG,
    sourceUnits: source?.units.map((row) => row.unitId) ?? [],
    sourceSignatureIds: source?.signatures.map((row) => row.id) ?? [],
    sourceAllocationOccurrences: source?.allocations.map((row) => row.occurrence) ?? [],
    objectUses: access.uses,
    intrinsics: VALUE_IDS.filter((id) => methods.includes(id) || held.has(id)),
    numberUses: numbers,
    unavailable: [
      ...NATIVE_REALM_CATALOG.intrinsics.flatMap((row) =>
        row.callable?.implementation === "unavailable" ? [{ id: row.id, role: row.callable.algorithm }] : [],
      ),
      ...NATIVE_REALM_CATALOG.remaining.map((role) => ({ id: "realm", role })),
    ],
    completionScope: "native-realm-bootstrap",
  };
}
/** Issue only from the exact prepared projection and real callable/property/conversion occurrences. */
export function deriveNativeRealmRequirements(
  program: PreparedIrProgram,
  projection: PreparedIrProgramRuntimeProjection,
  sourceRequirements?: NativeSourceClosureRequirements,
): NativeRealmRequirements | undefined {
  const access = deriveNativeObjectAccessRequirements(program, projection);
  const source =
    sourceRequirements === undefined ? planNativeSourceClosureRequirements(program, projection) : sourceRequirements;
  const data = calculate(program, projection, source, access);
  if (!data) return undefined;
  const description = freezePreparedIrValue(data) as NativeRealmDescription;
  const pack = Object.freeze({ program, projection, ...(source ? { source } : {}), access, description });
  return realmPacks.issue(pack);
}
/** A use checks only that the planner issued the pack (`issued-packs.ts`; #7354 Perf4). */
export const assertNativeRealmRequirementsIssued = realmPacks.assertIssued;
