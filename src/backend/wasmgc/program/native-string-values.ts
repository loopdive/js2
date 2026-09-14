// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { AllocSiteId } from "../../../ir/core/nodes.js";
import type { IrStringEncoding } from "../../../ir/core/string-types.js";
import type { IrFuncRef, IrGlobalRef } from "../../../ir/core/value-references.js";
import type { IrUnitId } from "../../../shared/contracts/ir-identity.js";
import type { PreparedIrProgramFailure } from "../../../ir/program/prepared-contracts.js";
import {
  collectNativeStringValueDemands,
  type NativeStringValueDemands,
} from "../../../ir/program/native-string-value-demands.js";
import {
  assertNativeValueResourcePlanFor,
  type NativeValueResourcePlan,
} from "../../../ir/program/native-value-resources.js";
import { freezePreparedIrValue, preparedIrDataMismatch } from "../../../ir/program/data.js";
import { PreparedIrProgramInvariantError } from "../../../ir/program/errors.js";
import type { Instr } from "../../../wasm/model/instructions.js";
import type {
  NativeStringValueDeclaration,
  NativeStringValueReservationStep,
} from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import type {
  PhysicalModuleReservations,
  TypeReservation,
  GlobalReservation,
  FunctionReservation,
} from "../../../wasm/physical/module-reservations.js";
import { selectNativeStringLiteral } from "../../../runtime/wasmgc/values/string-literal-bodies.js";
import {
  declareNativeStringLiteralTypes,
  declareNativeStringLiteralResources,
  reserveNativeStringLiteralResources,
  fillNativeStringLiteralResources,
  requireCompletedNativeStringLiterals,
  nativeStringLiteralReservationInventory,
  type NativeStringLiteralRequirements,
  type NativeStringLiteralReservations,
  type NativeStringLiteralTypeReservations,
} from "../resources/native-string-literals.js";
import {
  declareNativeStringFlattenResources,
  reserveNativeStringFlattenResources,
  fillNativeStringFlattenResources,
  requireCompletedNativeStringFlatten,
  type NativeStringFlattenReservations,
} from "../resources/native-string-flatten.js";
import {
  declareNativeStringNumberResources,
  reserveNativeStringNumberResources,
  fillNativeStringNumberResources,
  requireNativeStringNumberReservations,
  requireCompletedNativeStringNumber,
  type NativeStringNumberReservations,
} from "../resources/native-string-number.js";
import {
  declareNativeValueResources,
  reserveNativeValueResources,
  fillNativeValueResources,
  requireCompletedNativeValues,
  type NativeValueReservations,
} from "../resources/native-values.js";

export interface NativeStringValueOptions {
  readonly representation: "native-string";
  readonly utf8Storage: boolean;
}
export interface NativeStringValuePhysicalPlan {
  readonly key: string;
  readonly mode: "literals" | "number-boundary";
  readonly literalRequirements: NativeStringLiteralRequirements;
  readonly literalUses: readonly { readonly demandIndex: number; readonly cacheKey: string }[];
  readonly declarations: readonly NativeStringValueDeclaration[];
  readonly reservationSteps: readonly NativeStringValueReservationStep[];
}
export type NativeStringValuePlanningOutcome =
  | { readonly kind: "none" }
  | { readonly kind: "planned"; readonly plan: NativeStringValuePhysicalPlan }
  | PreparedIrProgramFailure;
export interface NativeStringValueReservationInput {
  readonly demands: NativeStringValueDemands;
  readonly plan: NativeStringValuePhysicalPlan;
  readonly valueRequirements?: NativeValueResourcePlan;
}
export type NativeStringValueResourceRow =
  | { readonly key: string; readonly space: "type"; readonly reservation: TypeReservation }
  | { readonly key: string; readonly space: "global"; readonly reservation: GlobalReservation }
  | { readonly key: string; readonly space: "function"; readonly reservation: FunctionReservation };
export interface NativeStringValueReservations {
  readonly strings: NativeStringLiteralReservations;
  readonly number?: {
    readonly flatten: NativeStringFlattenReservations;
    readonly scanner: NativeStringNumberReservations;
    readonly values: NativeValueReservations;
  };
}
function fail(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", "native string values: " + detail);
}
function same(a: unknown, b: unknown, detail: string) {
  if (preparedIrDataMismatch(a, b) !== undefined) fail(detail);
}
function located(demands: NativeStringValueDemands, occurrence: number, detail: string): PreparedIrProgramFailure {
  const use = demands.occurrences[occurrence];
  const id = use && demands.buffers[use.bufferIndex]?.ownerUnitId;
  const program = demands.program;
  const derived = program.derivedUnits.find((row) => row.id === id);
  const sourceUnit = program.inventory.allUnits.find((row) => row.id === id);
  const terminal = derived?.terminalOwnerId ?? sourceUnit?.terminalOwnerId ?? id;
  const owner = program.inventory.terminalUnits.find((row) => row.id === terminal);
  const source = owner && program.inventory.sources.find((row) => row.id === owner.sourceId);
  if (!owner || !source) fail("cannot locate demand: " + detail);
  return {
    kind: "unsupported",
    code: "body-shape-rejected",
    stage: "build",
    detail,
    unitId: owner.id,
    sourceFile: source.sourceKey,
    location: {
      sourceId: owner.sourceId,
      line: owner.line,
      column: owner.column,
      declarationStart: owner.declarationStart,
      declarationEnd: owner.declarationEnd,
    },
  };
}
function tuple(
  ownerUnitId: IrUnitId,
  value: string,
  alloc?: AllocSiteId,
  storage?: IrGlobalRef,
  materializer?: IrFuncRef,
) {
  return { ownerUnitId, value, alloc, storage, materializer };
}
function demandTuple(demands: NativeStringValueDemands, index: number) {
  const demand = demands.literals[index]!;
  if (demand.kind !== "string.const") fail("regex is not a literal binding");
  const occurrence = demands.occurrences[demand.occurrence]!;
  const owner = demands.buffers[occurrence.bufferIndex]!.ownerUnitId;
  const i = demand.instruction;
  return tuple(owner, i.value, i.alloc, i.storage, i.materializer);
}

/** Descriptive selection only; coordinator acceptance remains mandatory. */
export function planNativeStringValuePhysical(
  demands: NativeStringValueDemands,
  options: NativeStringValueOptions,
): NativeStringValuePlanningOutcome {
  if (options.representation !== "native-string" || typeof options.utf8Storage !== "boolean")
    fail("invalid representation options");
  same(
    demands,
    collectNativeStringValueDemands(demands.program, demands.projection),
    "stale or mismatched demand census",
  );
  const executable = (occurrence: number) =>
    demands.buffers[demands.occurrences[occurrence]!.bufferIndex]!.view === "projection";
  for (const [index, occurrence] of demands.occurrences.entries()) {
    const kind = occurrence.instruction.kind;
    if (executable(index) && ((kind.startsWith("string.") && kind !== "string.const") || kind === "forof.string"))
      return located(demands, index, `${kind} has no native string value resource join`);
  }
  const numeric = demands.intrinsics.some(
    (row) => executable(row.occurrence) && row.instruction.id === "js.number.unbox",
  );
  const literals: { value: string; encoding?: IrStringEncoding }[] = [];
  const uses: { demandIndex: number; cacheKey: string }[] = [];
  const references: { reference: IrGlobalRef | IrFuncRef; key: string }[] = [];
  for (const [index, demand] of demands.literals.entries()) {
    if (!executable(demand.occurrence)) continue;
    if (demand.kind === "extern.regex")
      return located(demands, demand.occurrence, "regex materialization is not supported by native string values");
    const i = demand.instruction;
    let encoding: IrStringEncoding | undefined;
    if (options.utf8Storage && demand.allocation.encoding.present) {
      const evidence = demand.allocation.encoding.value;
      if (evidence !== "ascii" && evidence !== "utf8-guaranteed" && evidence !== "wtf16")
        return located(demands, demand.occurrence, "invalid consumed string encoding metadata");
      encoding = evidence;
    }
    let selection: ReturnType<typeof selectNativeStringLiteral>;
    try {
      selection = selectNativeStringLiteral(options.utf8Storage, options.utf8Storage, i.value, encoding);
    } catch (error) {
      return located(demands, demand.occurrence, String(error));
    }
    if (
      (i.storage && selection.kind !== "global") ||
      (i.materializer && selection.kind !== "callable") ||
      (i.storage && i.materializer)
    )
      return located(demands, demand.occurrence, "existing literal storage/materializer contradicts native selection");
    const ref = i.storage ?? i.materializer;
    if (ref) {
      if (ref.binding.kind !== "support")
        return located(demands, demand.occurrence, "existing literal reference is not native support storage");
      if (
        references.some(
          (row) =>
            preparedIrDataMismatch(row.reference.binding, ref.binding) === undefined && row.key !== selection.key,
        )
      )
        return located(demands, demand.occurrence, "existing literal reference has contradictory selections");
      references.push({ reference: ref, key: selection.key });
    }
    if (
      uses.some(
        (row) =>
          preparedIrDataMismatch(demandTuple(demands, row.demandIndex), demandTuple(demands, index)) === undefined &&
          row.cacheKey !== selection.key,
      )
    )
      return located(demands, demand.occurrence, "ambiguous literal emitter tuple");
    literals.push({ value: i.value, encoding });
    uses.push({ demandIndex: index, cacheKey: selection.key });
  }
  if (!numeric && !uses.length) return { kind: "none" };
  const entry = demands.program.inventory.sources.find((row) => row.kind === "entry");
  if (!entry) fail("missing canonical entry source");
  const key = "native-string-values:v1:" + JSON.stringify(entry.id);
  if (numeric) literals.push({ value: "", encoding: "wtf16" });
  const literalRequirements = { key, utf8Storage: options.utf8Storage, literals };
  // Acceptance describes the same recipes the producers later execute. No
  // physical indices, scratch ledger, or post-reservation ABI additions.
  const recipes = [
    declareNativeStringLiteralTypes(key, options.utf8Storage),
    declareNativeStringLiteralResources(literalRequirements),
    ...(numeric
      ? [
          declareNativeStringFlattenResources(key + ":flatten", key, options.utf8Storage),
          declareNativeStringNumberResources(entry.id),
          declareNativeValueResources(entry.id),
        ]
      : []),
  ];
  return {
    kind: "planned",
    plan: freezePreparedIrValue({
      key,
      mode: numeric ? "number-boundary" : "literals",
      literalRequirements,
      literalUses: uses,
      declarations: recipes.flatMap((recipe) => recipe.declarations),
      reservationSteps: recipes.flatMap((recipe) => recipe.reservationSteps),
    }) as NativeStringValuePhysicalPlan,
  };
}

interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly input: NativeStringValueReservationInput;
  readonly snapshot: unknown;
  readonly rows: readonly NativeStringValueResourceRow[];
  filled: boolean;
}
const owners = new WeakMap<NativeStringValueReservations, Owner>();
function checkInput(input: NativeStringValueReservationInput) {
  const outcome = planNativeStringValuePhysical(input.demands, {
    representation: "native-string",
    utf8Storage: input.plan.literalRequirements.utf8Storage,
  });
  if (outcome.kind !== "planned") fail("input no longer has a materializable string plan");
  same(input.plan, outcome.plan, "demand/plan mismatch");
  if (input.plan.mode === "number-boundary") {
    if (!input.valueRequirements) fail("missing issued native value requirements");
    assertNativeValueResourcePlanFor(
      input.valueRequirements,
      input.demands.program,
      input.demands.projection,
      "native-string",
    );
  } else if (input.valueRequirements !== undefined) fail("unexpected native value requirements for literals mode");
}
function ownerFor(tx: PhysicalModuleReservations, pack: NativeStringValueReservations) {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied string value pack");
  same(owner.input.demands, owner.snapshot, "changed retained string demands");
  checkInput(owner.input);
  nativeStringLiteralReservationInventory(tx, pack.strings);
  if (pack.number)
    requireNativeStringNumberReservations(tx, pack.number.scanner, owner.input.valueRequirements!, pack.strings);
  for (const row of owner.rows) {
    if (tx.state === "reserving") {
      if (row.space === "type") tx.assertTypeReservation(row.reservation);
    } else tx.physicalIndex(row.reservation);
  }
  return owner;
}

export function reserveNativeStringValueResources(
  tx: PhysicalModuleReservations,
  input: NativeStringValueReservationInput,
  types: NativeStringLiteralTypeReservations,
): NativeStringValueReservations {
  checkInput(input);
  const strings = reserveNativeStringLiteralResources(tx, input.plan.literalRequirements, types);
  let number: NativeStringValueReservations["number"];
  if (input.plan.mode === "number-boundary") {
    const flatten = reserveNativeStringFlattenResources(tx, input.plan.key + ":flatten", strings);
    const scanner = reserveNativeStringNumberResources(tx, input.valueRequirements!, flatten);
    const values = reserveNativeValueResources(tx, input.valueRequirements!, {
      strings: { kind: "native-string", stringPack: strings, scanner },
    });
    number = Object.freeze({ flatten, scanner, values });
  }
  const pack = Object.freeze({ strings, ...(number ? { number } : {}) });
  const census = nativeStringLiteralReservationInventory(tx, strings);
  const rows: NativeStringValueResourceRow[] = [];
  const type = (reservation: TypeReservation) =>
    rows.push(Object.freeze({ key: reservation.key, space: "type", reservation }));
  const global = (reservation: GlobalReservation) =>
    rows.push(Object.freeze({ key: reservation.key, space: "global", reservation }));
  const fn = (reservation: FunctionReservation) =>
    rows.push(Object.freeze({ key: reservation.key, space: "function", reservation }));
  census.typePack.types.forEach(type);
  census.globals.forEach((row) => global(row.global));
  census.functions.forEach((row) => fn(row.function));
  if (number) {
    type(number.flatten.worklist);
    fn(number.flatten.copyTree);
    if (number.flatten.utf8Decoder) fn(number.flatten.utf8Decoder);
    fn(number.flatten.flatten);
    fn(number.scanner.toNumber);
    type(number.scanner.powerArray);
    global(number.scanner.powerGlobal);
    type(number.values.types.anyValue);
    global(number.values.globals.undefined);
    type(number.values.types.boxedNumber);
    type(number.values.types.boxedBoolean);
    fn(number.values.functions.boxNumber);
    fn(number.values.functions.unboxNumber);
    fn(number.values.functions.isNumber);
  }
  // Producers own the captured tokens; recipe order must not be reconstructed
  // by grouping all globals before all materializers (which loses interleaving).
  const byKey = new Map(rows.map((row) => [row.key, row]));
  if (byKey.size !== rows.length || rows.length !== input.plan.declarations.length)
    fail("missing, duplicate or extra captured resource");
  for (const declaration of input.plan.declarations) {
    const row = byKey.get(declaration.key);
    if (!row || row.space !== declaration.space) fail("captured resource does not match declared key/space");
  }
  const orderedRows = input.plan.reservationSteps.flatMap((step) =>
    step.kind === "reserve" ? [byKey.get(step.resourceKey) ?? fail("missing declared reservation")] : [],
  );
  if (orderedRows.length !== rows.length || new Set(orderedRows).size !== rows.length)
    fail("reservation steps do not cover the captured population exactly once");
  owners.set(pack, {
    tx,
    input: Object.freeze({ ...input, plan: freezePreparedIrValue(input.plan) as NativeStringValuePhysicalPlan }),
    snapshot: freezePreparedIrValue(input.demands),
    rows: Object.freeze(orderedRows),
    filled: false,
  });
  return pack;
}
export function nativeStringValueReservationInventory(
  tx: PhysicalModuleReservations,
  pack: NativeStringValueReservations,
): readonly NativeStringValueResourceRow[] {
  return ownerFor(tx, pack).rows;
}
export function fillNativeStringValueResources(
  tx: PhysicalModuleReservations,
  pack: NativeStringValueReservations,
): void {
  const owner = ownerFor(tx, pack);
  if (owner.filled) fail("duplicate native string value fill");
  fillNativeStringLiteralResources(tx, pack.strings);
  if (pack.number) {
    fillNativeStringFlattenResources(tx, pack.number.flatten);
    fillNativeStringNumberResources(tx, pack.number.scanner);
    fillNativeValueResources(tx, pack.number.values, {
      strings: { kind: "native-string", stringPack: pack.strings, scanner: pack.number.scanner },
    });
  }
  owner.filled = true;
}
export function requireCompletedNativeStringValues(
  tx: PhysicalModuleReservations,
  pack: NativeStringValueReservations,
): NativeStringValueReservations {
  const owner = ownerFor(tx, pack);
  if (!owner.filled) fail("incomplete native string value resources");
  requireCompletedNativeStringLiterals(tx, pack.strings);
  if (pack.number) {
    if (!owner.input.valueRequirements) fail("number resources lost their issued value requirements");
    requireCompletedNativeStringFlatten(tx, pack.number.flatten, pack.strings);
    requireCompletedNativeStringNumber(tx, pack.number.scanner, owner.input.valueRequirements!, pack.strings);
    requireCompletedNativeValues(tx, pack.number.values, owner.input.valueRequirements, {
      strings: { kind: "native-string", stringPack: pack.strings, scanner: pack.number.scanner },
    });
  }
  for (const row of owner.rows) tx.physicalIndex(row.reservation);
  return pack;
}
export function emitPreparedNativeStringLiteral(
  tx: PhysicalModuleReservations,
  pack: NativeStringValueReservations,
  ownerUnitId: IrUnitId,
  value: string,
  alloc?: AllocSiteId,
  storage?: IrGlobalRef,
  materializer?: IrFuncRef,
): readonly Instr[] {
  requireCompletedNativeStringValues(tx, pack);
  const owner = ownerFor(tx, pack);
  const requested = tuple(ownerUnitId, value, alloc, storage, materializer);
  const index = owner.input.plan.literalUses.findIndex(
    (row) => preparedIrDataMismatch(demandTuple(owner.input.demands, row.demandIndex), requested) === undefined,
  );
  if (index < 0) fail("literal tuple is outside the closed projection plan");
  const binding = nativeStringLiteralReservationInventory(tx, pack.strings).requests[index]!.binding;
  return binding.kind === "global"
    ? [{ op: "global.get", index: tx.physicalIndex(binding.global) }]
    : [{ op: "call", funcIdx: binding.function.handle }];
}
