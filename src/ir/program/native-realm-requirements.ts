// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import {
  NATIVE_ERROR_CONSTRUCTORS,
  NATIVE_OBJECT_PROTOTYPE_METHODS,
  NATIVE_REALM_CATALOG,
  NATIVE_VALUE_INTRINSICS,
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
   * since no other read can reach one; (#7354 G1) the Error family where the program can observe an error
   * ({@link heldErrorConstructors}).
   */
  readonly intrinsics: readonly string[];
  /**
   * (#7489) Whether the realm seeds %Function.prototype%'s `caller` / `arguments` accessors: where some [[Get]],
   * [[Set]] or HasProperty use can name one (its key, or a key not known at compile time). No other read reaches
   * them: no Prepared program obtains %Function.prototype% itself.
   */
  readonly restrictedFunctionAccessors: boolean;
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
const METHOD_IDS = NATIVE_VALUE_INTRINSICS.slice(0, NATIVE_OBJECT_PROTOTYPE_METHODS.length);
/** `Error.prototype.toString`'s id, and the family's: the Error constructors' and it. */
const ERROR_TO_STRING = NATIVE_VALUE_INTRINSICS.at(-1)!;
const FAMILY_IDS: readonly string[] = [...NATIVE_ERROR_CONSTRUCTORS.map((name) => `%${name}%`), ERROR_TO_STRING];
/** (#7354 P1) A use that reads a native Object.prototype method: the [[Get]] of its name, or the method itself. */
const readsPrototypeMethod = (use: Use): boolean =>
  METHOD_IDS.includes(intrinsicOf(use) ?? "") ||
  (use.feature === "js.object.get" &&
    (NATIVE_OBJECT_PROTOTYPE_METHODS as readonly (string | undefined)[]).includes(use.constantKey));
/** (#7489) The keys of %Function.prototype%'s restricted accessors, and the uses whose key can name one. */
const RESTRICTED_FUNCTION_KEYS: readonly (string | undefined)[] = ["caller", "arguments", undefined];
const CHAIN_FEATURES: ReadonlySet<string> = new Set(["js.object.get", "js.object.set", "js.object.has"]);
const readsRestrictedFunctionKey = (use: Use): boolean =>
  CHAIN_FEATURES.has(use.feature) && RESTRICTED_FUNCTION_KEYS.includes(use.constantKey);
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
/**
 * (#7354 G1) The Error family members the realm holds, derived only from what the program's IR emitted: where it uses
 * any member (an intrinsic read of one, `create-error`, `error-to-string`) or binds a caught value (the one way a realm
 * error becomes a program value), `Error`, `TypeError` (the realm's own errors) and `Error.prototype.toString`, with
 * every other constructor the IR reads. The legalization decides what to emit (`holdsErrors`); this never re-derives
 * that decision from the source, so the two cannot disagree. Where none is held no code reads an error.
 */
function heldErrorConstructors(uses: readonly Use[], program: PreparedIrProgram): ReadonlySet<string> {
  const named = new Set(uses.map(intrinsicOf).filter((id): id is string => id !== undefined));
  const used = [...named].some((id) => FAMILY_IDS.includes(id)) || uses.some((use) => ERROR_FEATURES.has(use.feature));
  if (!used && !bindsCaughtValue(program)) return new Set();
  return new Set(["%Error%", "%TypeError%", ERROR_TO_STRING, ...FAMILY_IDS.filter((id) => named.has(id))]);
}
/** (#7354 G1) The catalog rows of the realm `description` holds: those of every realm and those its constructors bring. */
export function heldCatalogRows(description: NativeRealmDescription): readonly NativeRealmIntrinsic[] {
  return description.catalog.intrinsics.filter(
    (row) => row.heldWith === undefined || description.intrinsics.includes(row.heldWith),
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
  const errors = heldErrorConstructors(access.uses, program);
  const methods = access.uses.some(readsPrototypeMethod);
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
    intrinsics: NATIVE_VALUE_INTRINSICS.filter((id) => (methods && METHOD_IDS.includes(id)) || errors.has(id)),
    restrictedFunctionAccessors: access.uses.some(readsRestrictedFunctionKey),
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
