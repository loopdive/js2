// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { NATIVE_REALM_CATALOG } from "../../runtime/contracts/native-realm-catalog.js";
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
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
