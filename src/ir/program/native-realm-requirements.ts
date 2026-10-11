// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { NATIVE_REALM_CATALOG } from "../../runtime/contracts/native-realm-catalog.js";
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import { irNumberConversionCallableDeclaration } from "../runtime/number-conversion-callable.js";
import { nativeAsyncCallableValueTypes, nativeAsyncCallMismatch } from "../runtime/native-async-callables.js";
import { freezePreparedIrValue, preparedIrDataMismatch } from "./data.js";
import type { PreparedIrProgram, PreparedIrProgramRuntimeProjection } from "./prepared-contracts.js";
import {
  deriveNativeObjectAccessRequirements,
  assertNativeObjectAccessRequirementsCurrent,
  type NativeObjectAccessRequirements,
} from "./native-object-access-requirements.js";
import {
  planNativeSourceClosureRequirements,
  assertNativeSourceClosureRequirementsCurrent,
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
interface Owner {
  readonly program: PreparedIrProgram;
  readonly projection: PreparedIrProgramRuntimeProjection;
  readonly source: NativeSourceClosureRequirements | undefined;
  readonly access: NativeObjectAccessRequirements;
  readonly description: NativeRealmDescription;
}
const owners = new WeakMap<NativeRealmRequirements, Owner>();
function fail(detail: string): never {
  throw Error("native realm requirements: " + detail);
}
function same(a: unknown, b: unknown, detail: string): void {
  if (preparedIrDataMismatch(a, b) !== undefined) fail(detail);
}
function numberUses(access: NativeObjectAccessRequirements): NativeRealmDescription["numberUses"] {
  const { demands } = access;
  return demands.owners.flatMap((owner) => {
    const rows = (view: "program" | "projection") =>
      demands.occurrences.flatMap((row, occurrence) => {
        const region = demands.buffers[row.bufferIndex]!,
          call = row.instruction;
        if (region.ownerUnitId !== owner.unitId || region.view !== view || call.kind !== "call") return [];
        const declaration = irNumberConversionCallableDeclaration(call.target);
        if (!declaration) return [];
        const fn = view === "program" ? owner.programFunction : owner.projectedFunction;
        const mismatch = nativeAsyncCallMismatch(call, declaration, nativeAsyncCallableValueTypes(fn));
        if (mismatch) fail("noncanonical Number callable: " + mismatch);
        return [{ occurrence, call }];
      });
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
    assertNativeSourceClosureRequirementsCurrent(source);
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
  if (sourceRequirements !== undefined) assertNativeSourceClosureRequirementsCurrent(sourceRequirements);
  const source =
    sourceRequirements === undefined ? planNativeSourceClosureRequirements(program, projection) : sourceRequirements;
  const data = calculate(program, projection, source, access);
  if (!data) return undefined;
  const description = freezePreparedIrValue(data) as NativeRealmDescription;
  const pack = Object.freeze({ program, projection, ...(source ? { source } : {}), access, description });
  owners.set(pack, { program, projection, source, access, description });
  return pack;
}
export function assertNativeRealmRequirementsCurrent(pack: NativeRealmRequirements): void {
  const owner = owners.get(pack);
  if (
    !owner ||
    pack.program !== owner.program ||
    pack.projection !== owner.projection ||
    pack.source !== owner.source ||
    pack.access !== owner.access ||
    pack.description !== owner.description
  )
    fail("unissued, copied or detached realm requirements");
  same(
    calculate(owner.program, owner.projection, owner.source, owner.access),
    owner.description,
    "realm catalog or demand selection changed",
  );
}
