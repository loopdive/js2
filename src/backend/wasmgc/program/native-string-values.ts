// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { AllocSiteId, IrInstr, IrStringLengthProvider } from "../../../ir/core/nodes.js";
import {
  IR_CLOSURE_VECTOR_APPLY,
  IR_CLOSURE_UNDEFINED,
  closureMethodArity,
} from "../../../ir/core/closure-invocation-callables.js";
import type { IrStringEncoding, IrStringConcatMode } from "../../../ir/core/string-types.js";
import type { IrFuncRef, IrGlobalRef } from "../../../ir/core/value-references.js";
import type { IrUnitId } from "../../../shared/contracts/ir-identity.js";
import { preparedStringLenProvider } from "../../../ir/runtime/intrinsic-preparation.js";
import type { NativeInvocationRequirements } from "../../../ir/program/native-invocation-requirements.js";
import type { NativeRealmRequirements } from "../../../ir/program/native-realm-requirements.js";
import {
  planNativeRealmLiterals,
  readNativeRealmLiteralInput,
  type NativeRealmLiteralPlan,
  type NativeRealmLiteralInput,
} from "./native-realm-literals.js";
import { nativeStringInvocationRequirements } from "./native-invocation-abi.js";
import { selectNativeBooleans, type NativeBooleanSelection } from "./native-primitive-boundary-abi.js";
import type { PreparedIrProgramFailure } from "../../../ir/program/prepared-contracts.js";
import {
  collectNativeStringValueDemands,
  nativeStringsReachCarrier,
  type NativeStringValueDemands,
  type NativeStringValueLiteralDemand,
} from "../../../ir/program/native-string-value-demands.js";
import {
  assertNativeValueResourcePlanFor,
  type NativeValueResourcePlan,
} from "../../../ir/program/native-value-resources.js";
import {
  freezePreparedIrValue,
  preparedIrDataMismatch,
  preparedIrFrozenCollectionMembers,
} from "../../../ir/program/data.js";
import { preparedIrSettledVerdicts, type PreparedIrSettlement } from "../../../shared/contracts/settled-verdict.js";
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
import {
  selectNativeStringLiteral,
  type NativeStringLiteralSelection,
} from "../../../runtime/wasmgc/values/string-literal-bodies.js";
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
  declareNativeStringEqualityResources,
  reserveNativeStringEqualityResources,
  fillNativeStringEqualityResources,
  requireCompletedNativeStringEquality,
  type NativeStringEqualityReservations,
} from "../resources/native-string-equality.js";
import {
  declareNativeValueResources,
  reserveNativeValueResources,
  fillNativeValueResources,
  requireCompletedNativeValues,
  type NativeValueReservations,
  type NativeValueDependencies,
} from "../resources/native-values.js";
import {
  declareNativeBooleanResources,
  reserveNativeBooleanResources,
  reserveNativeBooleanBoxResources,
  fillNativeBooleanResources,
  fillNativeBooleanBoxResources,
  requireCompletedNativeBooleans,
  requireCompletedNativeBooleanBoxes,
  type NativeBooleanReservations,
  type NativeBooleanBoxReservations,
} from "../resources/native-booleans.js";

import {
  declareNativeDynamicValueResources,
  reserveNativeDynamicValueResources,
  fillNativeDynamicValueResources,
  requireCompletedNativeDynamicValues,
  selectNativeDynamicValues,
  type NativeDynamicValueSelection,
  type NativeDynamicValueReservations,
} from "../resources/native-dynamic-values.js";
import {
  deriveNativeStringOutputRequirements,
  assertNativeStringOutputRequirementsCurrent,
  type NativeStringOutputRequirements,
} from "../../../ir/program/native-string-output-requirements.js";
import { planNativeStringOutputResources, type NativeStringOutputPhysicalPlan } from "./native-string-output.js";
import {
  reserveNativeStringOutputResources,
  nativeStringOutputReservationInventory,
  fillNativeStringOutputResources,
  requireCompletedNativeStringOutput,
  publishNativeStringOutput,
  type NativeStringOutputReservations,
} from "../resources/native-string-output.js";

export interface NativeStringValueOptions {
  readonly representation: "native-string";
  readonly stringConcatEmptyIdentity?: boolean;
  readonly utf8Storage: boolean;
}
export interface NativeStringValuePhysicalPlan {
  readonly key: string;
  readonly mode: "literals" | "number-boundary" | "realm-bootstrap";
  readonly booleans?: NativeBooleanSelection;
  readonly dynamicValues?: NativeDynamicValueSelection;
  /** (#7354 Str) An executable `string.eq` joins the lazy equality resource. */
  readonly equality?: true;
  readonly output?: NativeStringOutputPhysicalPlan;
  readonly literalRequirements: NativeStringLiteralRequirements;
  readonly literalUses: readonly { readonly demandIndex: number; readonly cacheKey: string }[];
  readonly declarations: readonly NativeStringValueDeclaration[];
  readonly reservationSteps: readonly NativeStringValueReservationStep[];
}
export type NativeStringValuePlanningOutcome =
  | { readonly kind: "none" }
  | {
      readonly kind: "planned";
      readonly plan: NativeStringValuePhysicalPlan;
      readonly invocationRequirements?: NativeInvocationRequirements;
      readonly realmLiterals?: NativeRealmLiteralPlan;
    }
  | PreparedIrProgramFailure;
export interface NativeStringValueReservationInput extends NativeRealmLiteralInput {
  readonly demands: NativeStringValueDemands;
  readonly plan: NativeStringValuePhysicalPlan;
  readonly valueRequirements?: NativeValueResourcePlan;
  readonly outputRequirements?: NativeStringOutputRequirements;
  readonly invocationRequirements?: NativeInvocationRequirements;
}
export type NativeStringValueResourceRow =
  | { readonly key: string; readonly space: "type"; readonly reservation: TypeReservation }
  | { readonly key: string; readonly space: "global"; readonly reservation: GlobalReservation }
  | { readonly key: string; readonly space: "function"; readonly reservation: FunctionReservation };
export interface NativeStringValueReservations {
  readonly strings: NativeStringLiteralReservations;
  readonly flatten?: NativeStringFlattenReservations;
  readonly equality?: NativeStringEqualityReservations;
  readonly output?: NativeStringOutputReservations;
  readonly number?: {
    readonly flatten: NativeStringFlattenReservations;
    readonly scanner: NativeStringNumberReservations;
    readonly values: NativeValueReservations;
    readonly dependencies: NativeValueDependencies;
    readonly booleans?: NativeBooleanReservations;
    readonly booleanBoxes?: NativeBooleanBoxReservations;
    readonly dynamicValues?: NativeDynamicValueReservations;
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
/**
 * Exact tuple equality. The primitive fields (compared as the deep comparison does, with Object.is) decide most pairs
 * without a deep comparison; planning compares all pairs and every emit scans the plan.
 */
function sameDemandTuple(demands: NativeStringValueDemands, index: number, other: ReturnType<typeof tuple>): boolean {
  const own = demandTuple(demands, index);
  return (
    Object.is(own.value, other.value) &&
    Object.is(own.ownerUnitId, other.ownerUnitId) &&
    Object.is(own.alloc, other.alloc) &&
    preparedIrDataMismatch(own, other) === undefined
  );
}

/**
 * The canonical literal one `string.const` demand selects: its encoding evidence (UTF-8 storage only) and the
 * selection, or why it has none. (#7354 Str) A literal use's cache key is derived from this alone, by the planner
 * and by the Prepared presentation's census.
 */
export function selectNativeLiteralDemand(
  demand: Extract<NativeStringValueLiteralDemand, { kind: "string.const" }>,
  utf8Storage: boolean,
):
  | { readonly encoding?: IrStringEncoding; readonly selection: NativeStringLiteralSelection }
  | { readonly detail: string } {
  let encoding: IrStringEncoding | undefined;
  if (utf8Storage && demand.allocation.encoding.present) {
    const evidence = demand.allocation.encoding.value;
    if (evidence !== "ascii" && evidence !== "utf8-guaranteed" && evidence !== "wtf16")
      return { detail: "invalid consumed string encoding metadata" };
    encoding = evidence;
  }
  try {
    return {
      encoding,
      selection: selectNativeStringLiteral(utf8Storage, utf8Storage, demand.instruction.value, encoding),
    };
  } catch (error) {
    return { detail: String(error) };
  }
}

/** Descriptive selection only; coordinator acceptance remains mandatory. */
export function planNativeStringValuePhysical(
  demands: NativeStringValueDemands,
  options: NativeStringValueOptions,
  expectedInvocation?: NativeInvocationRequirements,
  realmRequirements?: NativeRealmRequirements,
): NativeStringValuePlanningOutcome {
  if (options.representation !== "native-string" || typeof options.utf8Storage !== "boolean")
    fail("invalid representation options");
  same(
    demands,
    collectNativeStringValueDemands(demands.program, demands.projection),
    "stale or mismatched demand census",
  );
  const realmLiterals =
    realmRequirements === undefined ? undefined : planNativeRealmLiterals(realmRequirements, options.utf8Storage);
  if (
    realmRequirements &&
    (realmRequirements.program !== demands.program || realmRequirements.projection !== demands.projection)
  )
    fail("foreign realm program/projection");
  const executable = (occurrence: number) =>
    demands.buffers[demands.occurrences[occurrence]!.bufferIndex]!.view === "projection";
  const invocationRequirements = nativeStringInvocationRequirements(demands, options.utf8Storage, expectedInvocation);
  const boolean = selectNativeBooleans(demands, invocationRequirements);
  if (boolean.gap) return located(demands, boolean.gap.occurrence, boolean.gap.detail);
  const outputRequirements = deriveNativeStringOutputRequirements(
    demands,
    Object.freeze({ emptyIdentity: options.stringConcatEmptyIdentity ?? true }),
  );
  if ("kind" in outputRequirements) return outputRequirements;
  const invocation =
    !!invocationRequirements ||
    demands.occurrences.some((row, index) => {
      const instruction = row.instruction;
      return (
        executable(index) &&
        instruction.kind === "call" &&
        instruction.target.binding.kind === "intrinsic" &&
        (instruction.target.binding.symbol === IR_CLOSURE_VECTOR_APPLY ||
          instruction.target.binding.symbol === IR_CLOSURE_UNDEFINED ||
          closureMethodArity(instruction.target.binding.symbol) !== undefined)
      );
    });
  const dynamicValues = selectNativeDynamicValues(
    demands.intrinsics.filter((row) => executable(row.occurrence)).map((row) => row.instruction),
    nativeStringsReachCarrier(demands),
  );
  const numeric =
    invocation ||
    !!boolean.selection ||
    !!dynamicValues ||
    demands.intrinsics.some(
      (row) =>
        executable(row.occurrence) &&
        (row.instruction.id === "js.number.unbox" ||
          // (#7354 Ty) the number `typeof` test is the value resources' own predicate.
          row.instruction.id === "js.value.is_number" ||
          (row.instruction.id === "js.number.box" &&
            row.instruction.provider?.kind === "callable" &&
            row.instruction.provider.target.binding.kind === "runtime" &&
            row.instruction.provider.target.binding.symbol === "__box_number")),
    );
  const equality =
    !!dynamicValues?.strictEqStrings ||
    demands.occurrences.some((row, index) => executable(index) && row.instruction.kind === "string.eq");
  const literals: { value: string; encoding?: IrStringEncoding }[] = [];
  const uses: { demandIndex: number; cacheKey: string }[] = [];
  const references: { reference: IrGlobalRef | IrFuncRef; key: string }[] = [];
  for (const [index, demand] of demands.literals.entries()) {
    if (!executable(demand.occurrence)) continue;
    if (demand.kind === "extern.regex")
      return located(demands, demand.occurrence, "regex materialization is not supported by native string values");
    const i = demand.instruction;
    const selected = selectNativeLiteralDemand(demand, options.utf8Storage);
    if ("detail" in selected) return located(demands, demand.occurrence, selected.detail);
    const { encoding, selection } = selected;
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
          sameDemandTuple(demands, row.demandIndex, demandTuple(demands, index)) && row.cacheKey !== selection.key,
      )
    )
      return located(demands, demand.occurrence, "ambiguous literal emitter tuple");
    literals.push({ value: i.value, encoding });
    uses.push({ demandIndex: index, cacheKey: selection.key });
  }
  if (!numeric && !realmLiterals && !uses.length && !outputRequirements.binaryConcat) return { kind: "none" };
  const entry = demands.program.inventory.sources.find((row) => row.kind === "entry");
  if (!entry) fail("missing canonical entry source");
  const key = "native-string-values:v1:" + JSON.stringify(entry.id);
  const output = outputRequirements.binaryConcat
    ? planNativeStringOutputResources(outputRequirements, {
        key: key + ":output",
        stringKey: key,
        flattenKey: key + ":flatten",
      })
    : undefined;
  // Flattening needs the canonical empty literal.
  if (numeric || realmLiterals || output || equality) literals.push({ value: "", encoding: "wtf16" });
  if (invocation) literals.push({ value: "TypeError" }, { value: "Value is not callable" });
  if (outputRequirements.batchArities.length) literals.push({ value: "undefined" });
  if (realmLiterals) literals.push(...realmLiterals.literals);
  const literalRequirements = { key, utf8Storage: options.utf8Storage, literals };
  const values = numeric || realmLiterals ? declareNativeValueResources(entry.id) : undefined;
  const booleanType = values?.declarations.find((row) => row.role[0] === "values" && row.role[1] === "boolean");
  // Acceptance describes the same recipes the producers later execute. No
  // physical indices, scratch ledger, or post-reservation ABI additions.
  const recipes = [
    declareNativeStringLiteralTypes(key, options.utf8Storage),
    declareNativeStringLiteralResources(literalRequirements),
    ...(values || output || equality
      ? [declareNativeStringFlattenResources(key + ":flatten", key, options.utf8Storage)]
      : []),
    ...(equality ? [declareNativeStringEqualityResources(key + ":equality", key)] : []),
    ...(values ? [declareNativeStringNumberResources(entry.id), values] : []),
    ...(boolean.selection && booleanType
      ? [declareNativeBooleanResources(key + ":booleans", booleanType.key, boolean.selection)]
      : []),
    ...(dynamicValues ? [declareNativeDynamicValueResources(key + ":dynamic", dynamicValues, key)] : []),
    ...(output ? [output] : []),
  ];
  return {
    kind: "planned",
    ...(invocationRequirements ? { invocationRequirements } : {}),
    ...(realmLiterals ? { realmLiterals } : {}),
    plan: freezePreparedIrValue({
      key,
      mode: numeric ? "number-boundary" : realmLiterals ? "realm-bootstrap" : "literals",
      ...(boolean.selection ? { booleans: boolean.selection } : {}),
      ...(dynamicValues ? { dynamicValues } : {}),
      ...(equality ? { equality } : {}),
      ...(output ? { output } : {}),
      literalRequirements,
      literalUses: uses,
      declarations: recipes.flatMap((recipe) => recipe.declarations),
      reservationSteps: recipes.flatMap((recipe) => recipe.reservationSteps),
    }) as NativeStringValuePhysicalPlan,
  };
}

interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly sourceInput: NativeStringValueReservationInput;
  readonly input: NativeStringValueReservationInput;
  readonly snapshot: unknown;
  readonly rows: readonly NativeStringValueResourceRow[];
  filled: boolean;
  /** The retained input's checks, settled once it can no longer change (`checkUnlessSettled`). */
  readonly authentication: PreparedIrSettlement;
}
const owners = new WeakMap<NativeStringValueReservations, Owner>();
// Bound here rather than imported from the IR's binding: the backend reads the IR's frozen collections only through
// program data, which it already imports.
const { checkUnlessSettled, settledChecks } = preparedIrSettledVerdicts(preparedIrFrozenCollectionMembers);
/** A re-plan of the whole program: settled per input object, so the foundation and the reservation share it. */
const currentInputs = settledChecks<NativeStringValueReservationInput>();
export function assertNativeStringValueReservationInput(input: NativeStringValueReservationInput): void {
  currentInputs.check(input, () => checkReservationInput(input));
}
function checkReservationInput(input: NativeStringValueReservationInput): void {
  const realm = readNativeRealmLiteralInput(input, input.plan.literalRequirements.utf8Storage);
  const outcome = planNativeStringValuePhysical(
    input.demands,
    {
      representation: "native-string",
      utf8Storage: input.plan.literalRequirements.utf8Storage,
      stringConcatEmptyIdentity: input.plan.output?.options.emptyIdentity,
    },
    input.invocationRequirements,
    realm?.realmRequirements,
  );
  if (outcome.kind !== "planned") fail("input no longer has a materializable string plan");
  if (outcome.invocationRequirements !== input.invocationRequirements)
    fail("missing exact issued invocation requirements");
  if (outcome.realmLiterals !== realm?.realmLiterals) fail("missing exact issued realm literals");
  same(input.plan, outcome.plan, "demand/plan mismatch");
  if (input.plan.output) {
    if (!input.outputRequirements || input.outputRequirements.demands !== input.demands)
      fail("missing exact output requirements");
    assertNativeStringOutputRequirementsCurrent(input.outputRequirements);
    same(input.outputRequirements.options, input.plan.output.options, "output options changed");
  } else if (input.outputRequirements !== undefined) fail("unexpected output requirements");
  if (input.plan.mode !== "literals") {
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
  checkUnlessSettled(owner.authentication, owner.input, () => {
    same(owner.input.demands, owner.snapshot, "changed retained string demands");
    assertNativeStringValueReservationInput(owner.input);
  });
  const currentRealm = readNativeRealmLiteralInput(owner.sourceInput, owner.input.plan.literalRequirements.utf8Storage);
  if (
    currentRealm?.realmRequirements !== owner.input.realmRequirements ||
    currentRealm?.realmLiterals !== owner.input.realmLiterals
  )
    fail("changed retained realm literal identities");
  nativeStringLiteralReservationInventory(tx, pack.strings);
  if (pack.output) nativeStringOutputReservationInventory(tx, pack.output, owner.input.plan.output!);
  if (pack.number)
    requireNativeStringNumberReservations(tx, pack.number.scanner, owner.input.valueRequirements!, pack.strings);
  if (tx.state === "reserving") {
    for (const row of owner.rows) if (row.space === "type") tx.assertTypeReservation(row.reservation);
  } else tx.physicalIndices(owner.rows.map((row) => row.reservation));
  return owner;
}

export function reserveNativeStringValueResources(
  tx: PhysicalModuleReservations,
  input: NativeStringValueReservationInput,
  types: NativeStringLiteralTypeReservations,
): NativeStringValueReservations {
  assertNativeStringValueReservationInput(input);
  const strings = reserveNativeStringLiteralResources(tx, input.plan.literalRequirements, types);
  const flatten =
    input.plan.mode !== "literals" || input.plan.output || input.plan.equality
      ? reserveNativeStringFlattenResources(tx, input.plan.key + ":flatten", strings)
      : undefined;
  const equality =
    input.plan.equality && flatten
      ? reserveNativeStringEqualityResources(tx, input.plan.key + ":equality", flatten, true)
      : undefined;
  let number: NativeStringValueReservations["number"];
  if (input.plan.mode !== "literals") {
    if (!flatten) fail("number resources require flatten");
    const scanner = reserveNativeStringNumberResources(tx, input.valueRequirements!, flatten);
    const dependencies: NativeValueDependencies = Object.freeze({
      strings: { kind: "native-string" as const, stringPack: strings, scanner },
    });
    const values = reserveNativeValueResources(tx, input.valueRequirements!, dependencies);
    const key = input.plan.key + ":booleans";
    const booleanBoxes = input.plan.booleans?.boxMode
      ? reserveNativeBooleanBoxResources(
          tx,
          key,
          values,
          input.valueRequirements!,
          dependencies,
          input.plan.booleans.boxMode,
        )
      : undefined;
    const booleans = input.plan.booleans?.unbox
      ? reserveNativeBooleanResources(tx, key, values, input.valueRequirements!, dependencies)
      : undefined;
    const dynamicValues = input.plan.dynamicValues
      ? reserveNativeDynamicValueResources(
          tx,
          input.plan.key + ":dynamic",
          input.plan.dynamicValues,
          values,
          booleans,
          input.valueRequirements!,
          dependencies,
          input.plan.dynamicValues.strictEqStrings
            ? { anyStrTypeIdx: strings.layout.anyStrTypeIdx, flatten: flatten.flatten, equals: equality!.equals }
            : undefined,
        )
      : undefined;
    number = Object.freeze({
      flatten,
      scanner,
      values,
      dependencies,
      ...(booleanBoxes ? { booleanBoxes } : {}),
      ...(booleans ? { booleans } : {}),
      ...(dynamicValues ? { dynamicValues } : {}),
    });
  }
  const output =
    input.plan.output && input.outputRequirements && flatten
      ? reserveNativeStringOutputResources(tx, input.outputRequirements, input.plan.output, { strings, flatten })
      : undefined;
  const pack = Object.freeze({
    strings,
    ...(flatten ? { flatten } : {}),
    ...(number ? { number } : {}),
    ...(equality ? { equality } : {}),
    ...(output ? { output } : {}),
  });
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
  if (flatten) {
    type(flatten.worklist);
    fn(flatten.copyTree);
    if (flatten.utf8Decoder) fn(flatten.utf8Decoder);
    fn(flatten.flatten);
  }
  if (equality) fn(equality.equals);
  if (number) {
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
    if (number.booleanBoxes) {
      fn(number.booleanBoxes.boxBoolean);
      number.booleanBoxes.globals.forEach(global);
    }
    if (number.booleans) {
      fn(number.booleans.isBoolean);
      fn(number.booleans.unboxBoolean);
    }
    if (number.dynamicValues) Object.values(number.dynamicValues).forEach(fn);
  }
  if (output) {
    for (const row of nativeStringOutputReservationInventory(tx, output, input.plan.output!)) {
      if (row.kind === "type") type(row);
      else if (row.kind === "global") global(row);
      else fn(row);
    }
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
    sourceInput: input,
    input: Object.freeze({ ...input }),
    snapshot: freezePreparedIrValue(input.demands),
    rows: Object.freeze(orderedRows),
    filled: false,
    authentication: { settled: undefined },
  });
  return pack;
}
export function nativeStringValueReservationInventory(
  tx: PhysicalModuleReservations,
  pack: NativeStringValueReservations,
): readonly NativeStringValueResourceRow[] {
  return ownerFor(tx, pack).rows;
}
/** `closureRoot`: the source closures' wrapper root, which the dynamic value's function test reads. */
export function fillNativeStringValueResources(
  tx: PhysicalModuleReservations,
  pack: NativeStringValueReservations,
  closureRoot: TypeReservation | undefined,
): void {
  const owner = ownerFor(tx, pack);
  if (owner.filled) fail("duplicate native string value fill");
  fillNativeStringLiteralResources(tx, pack.strings);
  if (pack.flatten) fillNativeStringFlattenResources(tx, pack.flatten);
  if (pack.number) {
    fillNativeStringNumberResources(tx, pack.number.scanner);
    fillNativeValueResources(tx, pack.number.values, {
      strings: { kind: "native-string", stringPack: pack.strings, scanner: pack.number.scanner },
    });
    if (pack.number.booleanBoxes) fillNativeBooleanBoxResources(tx, pack.number.booleanBoxes);
    if (pack.number.booleans) fillNativeBooleanResources(tx, pack.number.booleans);
    if (pack.number.dynamicValues) fillNativeDynamicValueResources(tx, pack.number.dynamicValues, closureRoot);
  }
  if (pack.equality) fillNativeStringEqualityResources(tx, pack.equality);
  if (pack.output) fillNativeStringOutputResources(tx, pack.output);
  owner.filled = true;
}
export function publishNativeStringValueOutput(
  tx: PhysicalModuleReservations,
  pack: NativeStringValueReservations,
): void {
  requireCompletedNativeStringValues(tx, pack);
  if (pack.output) publishNativeStringOutput(tx, pack.output);
}
export function requireCompletedNativeStringValues(
  tx: PhysicalModuleReservations,
  pack: NativeStringValueReservations,
): NativeStringValueReservations {
  completedOwner(tx, pack);
  return pack;
}
/** Every emit runs this; its nested completion queries share the one layout audit taken after them. */
function completedOwner(tx: PhysicalModuleReservations, pack: NativeStringValueReservations): Owner {
  return tx.audited(() => checkCompletedOwner(tx, pack));
}
function checkCompletedOwner(tx: PhysicalModuleReservations, pack: NativeStringValueReservations): Owner {
  const owner = ownerFor(tx, pack);
  if (!owner.filled) fail("incomplete native string value resources");
  requireCompletedNativeStringLiterals(tx, pack.strings);
  if (pack.flatten) requireCompletedNativeStringFlatten(tx, pack.flatten, pack.strings);
  if (pack.equality) requireCompletedNativeStringEquality(tx, pack.equality, pack.strings);
  if (pack.output) requireCompletedNativeStringOutput(tx, pack.output);
  if (pack.number) {
    if (!owner.input.valueRequirements) fail("number resources lost their issued value requirements");
    requireCompletedNativeStringNumber(tx, pack.number.scanner, owner.input.valueRequirements!, pack.strings);
    requireCompletedNativeValues(tx, pack.number.values, owner.input.valueRequirements, {
      strings: { kind: "native-string", stringPack: pack.strings, scanner: pack.number.scanner },
    });
    if (pack.number.booleanBoxes)
      requireCompletedNativeBooleanBoxes(
        tx,
        pack.number.booleanBoxes,
        pack.number.values,
        owner.input.valueRequirements,
        pack.number.dependencies,
      );
    if (pack.number.dynamicValues) requireCompletedNativeDynamicValues(tx, pack.number.dynamicValues);
    if (pack.number.booleans)
      requireCompletedNativeBooleans(
        tx,
        pack.number.booleans,
        pack.number.values,
        owner.input.valueRequirements,
        pack.number.dependencies,
      );
  }
  tx.physicalIndices(owner.rows.map((row) => row.reservation));
  return owner;
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
  // The literal's inventory and index queries share the completion check's one trailing layout audit.
  return tx.audited((): readonly Instr[] => {
    const owner = checkCompletedOwner(tx, pack);
    const requested = tuple(ownerUnitId, value, alloc, storage, materializer);
    const index = owner.input.plan.literalUses.findIndex((row) =>
      sameDemandTuple(owner.input.demands, row.demandIndex, requested),
    );
    if (index < 0) fail("literal tuple is outside the closed projection plan");
    const binding = nativeStringLiteralReservationInventory(tx, pack.strings).requests[index]!.binding;
    return binding.kind === "global"
      ? [{ op: "global.get", index: tx.physicalIndex(binding.global) }]
      : [{ op: "call", funcIdx: binding.function.handle }];
  });
}

/**
 * The scoped emitter may only realize an authenticated occurrence of its owner: one of `occurrences` (indices into
 * the demand census) in the owner's executable projection that `admits` the emitted request.
 */
function requireOwnerOccurrence(
  tx: PhysicalModuleReservations,
  pack: NativeStringValueReservations,
  ownerUnitId: IrUnitId,
  kind: string,
  occurrences: (owner: Owner) => readonly number[],
  admits: (instruction: IrInstr) => boolean,
): Owner {
  const owner = completedOwner(tx, pack);
  const { demands } = owner.input;
  const admitted = occurrences(owner).some((index) => {
    const occurrence = demands.occurrences[index]!;
    const buffer = demands.buffers[occurrence.bufferIndex]!;
    return buffer.view === "projection" && buffer.ownerUnitId === ownerUnitId && admits(occurrence.instruction);
  });
  if (!admitted) fail(kind + " occurrence is outside the closed owner projection");
  return owner;
}
const allOccurrences = (owner: Owner) => owner.input.demands.occurrences.map((_, index) => index);

function emitPreparedNativeStringConcat(
  tx: PhysicalModuleReservations,
  pack: NativeStringValueReservations,
  ownerUnitId: IrUnitId,
  alloc?: AllocSiteId,
  mode: IrStringConcatMode = "immutable",
  provider?: IrFuncRef,
): readonly Instr[] {
  if (!pack.output || mode !== "immutable") fail("concat has no admitted output resource");
  requireOwnerOccurrence(
    tx,
    pack,
    ownerUnitId,
    "concat",
    (owner) =>
      owner.input.outputRequirements?.uses.flatMap((use) => (use.kind === "binary-concat" ? [use.occurrence] : [])) ??
      [],
    (instruction) =>
      instruction.kind === "string.concat" &&
      instruction.alloc === alloc &&
      (instruction.concatMode ?? "immutable") === mode &&
      instruction.provider === provider,
  );
  return [{ op: "call", funcIdx: pack.output.concat.handle }];
}

/**
 * (#7354 Str) `string.eq` calls the lazy equality resource, which the plan selects for every executable `string.eq`
 * (`planNativeStringValuePhysical`), so an admitted occurrence has it.
 */
function emitPreparedNativeStringEquals(
  tx: PhysicalModuleReservations,
  pack: NativeStringValueReservations,
  ownerUnitId: IrUnitId,
  provider?: IrFuncRef,
): readonly Instr[] {
  requireOwnerOccurrence(
    tx,
    pack,
    ownerUnitId,
    "string.eq",
    allOccurrences,
    (instruction) => instruction.kind === "string.eq" && instruction.provider === provider,
  );
  return [{ op: "call", funcIdx: pack.equality!.equals.handle }];
}

/** (#7354 Str) `string.len` reads the carrier field the selected `js.string.len` provider names. */
function emitPreparedNativeStringLength(
  tx: PhysicalModuleReservations,
  pack: NativeStringValueReservations,
  ownerUnitId: IrUnitId,
  provider?: IrStringLengthProvider,
): readonly Instr[] {
  const owner = requireOwnerOccurrence(
    tx,
    pack,
    ownerUnitId,
    "string.len",
    allOccurrences,
    (instruction) => instruction.kind === "string.len" && instruction.provider === provider,
  );
  const field = preparedStringLenProvider(owner.input.demands.projection.prepared);
  if (field?.arm !== "native") fail("string.len has no selected carrier field");
  return [{ op: "struct.get", typeIdx: pack.strings.layout.anyStrTypeIdx, fieldIdx: field.fieldIndex }];
}

/**
 * The string operations of one owner's body, each realised on the owner's admitted native resources and only for
 * an occurrence of that owner's executable projection.
 */
export function preparedNativeStringResolver(
  tx: PhysicalModuleReservations,
  pack: NativeStringValueReservations,
  ownerUnitId: IrUnitId,
): {
  readonly emitStringConst: (
    value: string,
    alloc?: AllocSiteId,
    storage?: IrGlobalRef,
    materializer?: IrFuncRef,
  ) => readonly Instr[];
  readonly emitStringConcat?: (
    alloc?: AllocSiteId,
    mode?: IrStringConcatMode,
    provider?: IrFuncRef,
  ) => readonly Instr[];
  readonly emitStringEquals: (provider?: IrFuncRef) => readonly Instr[];
  readonly emitStringLen: (inputEncoding?: IrStringEncoding, provider?: IrStringLengthProvider) => readonly Instr[];
} {
  return {
    emitStringConst: (value, alloc, storage, materializer) =>
      emitPreparedNativeStringLiteral(tx, pack, ownerUnitId, value, alloc, storage, materializer),
    ...(pack.output
      ? {
          emitStringConcat: (alloc, mode, provider) =>
            emitPreparedNativeStringConcat(tx, pack, ownerUnitId, alloc, mode, provider),
        }
      : {}),
    emitStringEquals: (provider) => emitPreparedNativeStringEquals(tx, pack, ownerUnitId, provider),
    emitStringLen: (_inputEncoding, provider) => emitPreparedNativeStringLength(tx, pack, ownerUnitId, provider),
  };
}
