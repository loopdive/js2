// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { PreparedIrProgramInvariantError } from "../../../ir/program/errors.js";
import { freezePreparedIrValue, preparedIrDataMismatch } from "../../../ir/program/data.js";
import {
  assertNativePromiseSourceCensusCurrent,
  type NativePromiseSourceCensus,
  type CarrierEvidence,
  type PromiseLookupFacts,
  type ConstructionOp,
} from "../../../ir/program/native-promise-inventory.js";
import { assertNativeValueResourcePlanFor } from "../../../ir/program/native-value-resources.js";
import {
  assertNativeStringOutputRequirementsCurrent,
  deriveNativeStringOutputRequirements,
} from "../../../ir/program/native-string-output-requirements.js";
import {
  planNativeStringValuePhysical,
  type NativeStringValueReservationInput,
} from "../program/native-string-values.js";
import type { NativeStringValueDeclaration } from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import type { Instr } from "../../../wasm/model/instructions.js";
import type { TypeDef, WasmFunction, GlobalDef } from "../../../wasm/model/module-records.js";
import { walkChildren } from "../../../wasm/model/instruction-walk.js";
import { indexPhysicalTypes } from "../../../wasm/physical/type-layout.js";

function invalid(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", `native Promise inventory: ${detail}`);
}
function same(actual: unknown, expected: unknown, detail: string): void {
  if (preparedIrDataMismatch(actual, expected) !== undefined) invalid(detail);
}
function dense<T>(rows: readonly T[], label: string): void {
  if (!Array.isArray(rows)) invalid(`missing ${label}`);
  for (let i = 0; i < rows.length; i++)
    if (!Object.hasOwn(rows, i) || rows[i] === undefined) invalid(`sparse ${label}`);
}
export interface CarrierRow {
  readonly key: string;
  readonly declaration: Extract<NativeStringValueDeclaration, { readonly space: "type" }>;
  readonly evidence: readonly CarrierEvidence[];
}
/** Descriptive only: validates overlap without granting dispatch or lookup authority. */
export function validateNativePromiseLookupFacts(carriers: readonly CarrierRow[], facts: PromiseLookupFacts): void {
  dense(carriers, "carriers");
  const keys = new Set<string>();
  carriers.forEach((row) => {
    if (keys.has(row.key) || row.key !== row.declaration.key) invalid("duplicate or mismatched carrier ownership");
    keys.add(row.key);
  });
  for (const rows of [facts.methods, facts.accessors, facts.fields, facts.callableRoots]) {
    dense<{ readonly carrier: string }>(rows, "lookup facts");
    const seen = new Set<string>();
    rows.forEach((row) => {
      if (!keys.has(row.carrier) || seen.has(row.carrier)) invalid("unknown or duplicate lookup carrier");
      if (carriers.find((carrier) => carrier.key === row.carrier)!.declaration.shape.kind !== "struct")
        invalid("array lookup fact");
      seen.add(row.carrier);
    });
  }
  facts.fields.forEach((row) => {
    const shape = carriers.find((carrier) => carrier.key === row.carrier)!.declaration.shape;
    if (
      shape.kind !== "struct" ||
      !Number.isSafeInteger(row.fieldIndex) ||
      row.fieldIndex < 0 ||
      row.fieldIndex >= shape.fields.length
    )
      invalid("invalid lookup field");
  });
}

export function compareNativePromiseLookupFacts(
  expected: { readonly carriers: readonly CarrierRow[]; readonly facts: PromiseLookupFacts },
  observed: { readonly carriers: readonly CarrierRow[]; readonly facts: PromiseLookupFacts },
): void {
  validateNativePromiseLookupFacts(expected.carriers, expected.facts);
  validateNativePromiseLookupFacts(observed.carriers, observed.facts);
  if (preparedIrDataMismatch(expected, observed) !== undefined) invalid("descriptive lookup population differs");
}
export interface NativeCarrierProducerObservation {
  readonly kind: "native-string-values";
  readonly input: NativeStringValueReservationInput;
  readonly declarations: NativeStringValueReservationInput["plan"]["declarations"];
  readonly reservationSteps: NativeStringValueReservationInput["plan"]["reservationSteps"];
  readonly carriers: readonly CarrierRow[];
}
const observations = new WeakMap<
  NativeCarrierProducerObservation,
  {
    readonly source: NativePromiseSourceCensus;
    readonly snapshot: unknown;
    readonly plan: NativeStringValueReservationInput["plan"];
    readonly demands: NativeStringValueReservationInput["demands"];
  }
>();

/** Fixed, partial owner adapter. No configuration, reservation or executable authority is inferred. */
export function observeNativeStringValueProducer(
  source: NativePromiseSourceCensus,
  input: NativeStringValueReservationInput,
): NativeCarrierProducerObservation {
  assertNativePromiseSourceCensusCurrent(source);
  const { program, projection, options } = source;
  const demands = input.demands,
    fresh = source.demands;
  same(demands, fresh, "stale or incomplete string source census");
  if (
    demands.program !== program ||
    demands.projection !== projection ||
    demands.allocations !== fresh.allocations ||
    fresh.owners.some(
      (row, i) =>
        row.programFunction !== demands.owners[i]?.programFunction ||
        row.projectedFunction !== demands.owners[i]?.projectedFunction,
    ) ||
    fresh.buffers.some((row, i) => row.instructions !== demands.buffers[i]?.instructions) ||
    fresh.occurrences.some((row, i) => row.instruction !== demands.occurrences[i]?.instruction)
  )
    invalid("detached borrowed string source");
  fresh.literals.forEach((row, i) => {
    const prior = demands.literals[i];
    if (row.kind !== "string.const" || prior?.kind !== "string.const") return;
    if (
      row.instruction !== prior.instruction ||
      (row.allocation.metadataRow.present &&
        (!prior.allocation.metadataRow.present ||
          row.allocation.metadataRow.value !== prior.allocation.metadataRow.value)) ||
      (row.allocation.encoding.present &&
        (!prior.allocation.encoding.present ||
          !Object.is(row.allocation.encoding.value, prior.allocation.encoding.value)))
    )
      invalid("detached literal metadata");
  });
  const current = planNativeStringValuePhysical(fresh, {
    representation: "native-string",
    utf8Storage: options.utf8Storage === true,
    stringConcatEmptyIdentity: options.stringConcatEmptyIdentity ?? true,
  });
  if (current.kind !== "planned") invalid("string declaration input has no current planned producer");
  same(input.plan, current.plan, "changed native string declaration recipe");
  if (current.plan.mode === "number-boundary") {
    if (!input.valueRequirements) invalid("missing value requirements");
    assertNativeValueResourcePlanFor(input.valueRequirements, program, projection, "native-string");
  } else if (input.valueRequirements !== undefined) invalid("unexpected native value requirements for literals mode");
  if (current.plan.output) {
    if (!input.outputRequirements) invalid("missing output requirements");
    assertNativeStringOutputRequirementsCurrent(input.outputRequirements);
    if (input.outputRequirements.demands !== demands) invalid("detached output demand association");
    same(
      input.outputRequirements,
      deriveNativeStringOutputRequirements(fresh, current.plan.output.options),
      "changed output requirements",
    );
  } else if (input.outputRequirements !== undefined) invalid("unexpected output requirements");
  const carriers: CarrierRow[] = [];
  const keys = new Set<string>();
  input.plan.declarations.forEach((declaration, index) => {
    if (keys.has(declaration.key)) invalid("duplicate declaration ownership");
    keys.add(declaration.key);
    if (declaration.space === "type")
      carriers.push(
        Object.freeze({
          key: declaration.key,
          declaration,
          evidence: Object.freeze([Object.freeze({ kind: "recipe" as const, producer: 0, declaration: index })]),
        }),
      );
  });
  const observation = Object.freeze({
    kind: "native-string-values" as const,
    input,
    declarations: input.plan.declarations,
    reservationSteps: input.plan.reservationSteps,
    carriers: Object.freeze(carriers),
  });
  observations.set(observation, {
    source,
    snapshot: freezePreparedIrValue(input),
    plan: input.plan,
    demands: input.demands,
  });
  return observation;
}

export function assertNativeStringValueProducerObservationCurrent(observation: NativeCarrierProducerObservation): void {
  const issued = observations.get(observation);
  if (!issued) invalid("unobserved producer record");
  if (observation.input.plan !== issued.plan || observation.input.demands !== issued.demands)
    invalid("detached producer input");
  same(observation.input, issued.snapshot, "changed producer input");
  const source = issued.source;
  const fresh = observeNativeStringValueProducer(source, observation.input);
  if (
    observation.declarations !== observation.input.plan.declarations ||
    observation.reservationSteps !== observation.input.plan.reservationSteps ||
    fresh.carriers.some((row, i) => row.declaration !== observation.carriers[i]?.declaration)
  )
    invalid("detached producer association");
  same(fresh, observation, "changed producer observation");
}

export interface NativeConstructionOccurrence {
  readonly op: ConstructionOp;
  readonly typeIndex: number;
}
/** A detached descriptive scan, not completed-reservation or whole-module certification. */
export function scanNativePromiseConstructions(
  body: readonly Instr[],
  types: readonly TypeDef[],
): readonly NativeConstructionOccurrence[] {
  const table = indexPhysicalTypes(types);
  const found: NativeConstructionOccurrence[] = [];
  const active = new Set<readonly Instr[]>();
  const visit = (instructions: readonly Instr[]): void => {
    dense(instructions, "instruction buffer");
    if (active.has(instructions)) invalid("cyclic Wasm instruction buffer");
    active.add(instructions);
    for (const instruction of instructions) {
      const op = instruction.op;
      if (op === "struct.new" || op === "array.new" || op === "array.new_fixed" || op === "array.new_default") {
        const typeIndex = instruction.typeIdx;
        if (!Number.isSafeInteger(typeIndex) || typeIndex < 0) invalid("invalid construction type coordinate");
        const definition = table.entries[typeIndex]?.definition;
        const shape = definition?.kind === "sub" ? definition.type : definition;
        if (!shape || shape.kind !== (op === "struct.new" ? "struct" : "array"))
          invalid("wrong construction target type");
        found.push(Object.freeze({ op, typeIndex }));
      } else if (/^(struct|array)\.new/.test(op)) invalid(`unsupported construction opcode ${op}`);
      // The canonical child walker ignores malformed children; reject them before walking.
      const record = instruction as unknown as Record<string, unknown>;
      if (["block", "loop", "try", "try_table"].includes(op)) dense(record.body as readonly Instr[], `${op} body`);
      if (op === "if") dense(record.then as readonly Instr[], "if then");
      for (const key of ["body", "then", "else", "catchAll"])
        if (Object.hasOwn(record, key) && record[key] !== undefined && !Array.isArray(record[key]))
          invalid(`malformed ${key} buffer`);
      if (Object.hasOwn(record, "catches") && record.catches !== undefined) {
        dense(record.catches as readonly { body: Instr[] }[], "catches");
        for (const arm of record.catches as readonly { body: Instr[] }[]) dense(arm.body, "catch body");
      }
      walkChildren(instruction, visit);
    }
    active.delete(instructions);
  };
  visit(body);
  return Object.freeze(found);
}

export interface NativeConstructionRootExpectation {
  readonly space: "function" | "global";
  /** Actual defined storage coordinate, not a physical index including imports. */
  readonly index: number;
  readonly allocations: readonly NativeConstructionOccurrence[];
}
/** Exact bounded module comparison. Caller expectations must be independent of this scan.
 * No ownership/completion witness is issued; the parent must authenticate reservations separately. */
export function compareNativePromiseConstructions(
  module: {
    readonly types: readonly TypeDef[];
    readonly functions: readonly WasmFunction[];
    readonly globals: readonly GlobalDef[];
  },
  expected: readonly NativeConstructionRootExpectation[],
): void {
  dense(expected, "construction expectations");
  dense(module.functions, "module functions");
  dense(module.globals, "module globals");
  const roots = new Map<string, NativeConstructionRootExpectation>();
  for (const row of expected) {
    const key = `${row.space}:${row.index}`;
    if (
      !Number.isSafeInteger(row.index) ||
      row.index < 0 ||
      roots.has(key) ||
      (row.space !== "function" && row.space !== "global")
    )
      invalid("duplicate or invalid construction root");
    dense(row.allocations, "construction sequence");
    roots.set(key, row);
  }
  const check = (space: "function" | "global", index: number, body: readonly Instr[]): void => {
    const key = `${space}:${index}`,
      row = roots.get(key);
    if (!row) invalid(`unowned construction root ${key}`);
    same(
      scanNativePromiseConstructions(body, module.types),
      row.allocations,
      `construction sequence differs for ${key}`,
    );
    roots.delete(key);
  };
  module.functions.forEach((fn, index) => check("function", index, fn.body));
  module.globals.forEach((global, index) => check("global", index, global.init));
  if (roots.size) invalid("omitted construction roots");
}
