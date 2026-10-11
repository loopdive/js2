// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { forEachNestedBuffer, type IrFunction, type IrInstr, type AllocSiteId } from "../core/nodes.js";
import type { IrFuncRef } from "../core/value-references.js";
import type { IrUnitId, IrBindingId } from "../../shared/contracts/ir-identity.js";
import type { PreparedIrProgram, PreparedIrProgramRuntimeProjection } from "./prepared-contracts.js";
import { PreparedIrProgramInvariantError } from "./errors.js";
import { freezePreparedIrValue, preparedIrDataMismatch } from "./data.js";
import {
  collectNativeStringValueDemands,
  type NativeStringValueDemands,
  type NativeStringValueBuffer,
  type NativeStringValueOccurrence,
} from "./native-string-value-demands.js";
import { irRuntimeSupportFunctions } from "./runtime-support.js";

function invalid(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", `native Promise inventory: ${detail}`);
}
function dense<T>(rows: readonly T[]): void {
  if (!Array.isArray(rows)) invalid("missing array");
  for (let i = 0; i < rows.length; i++) if (!Object.hasOwn(rows, i) || rows[i] === undefined) invalid("sparse array");
}

export interface NativePromiseInventoryObligation {
  readonly code:
    | "missing-runtime-configuration"
    | "producer-declaration"
    | "source-carrier-association"
    | "dispatch-evidence"
    | "construction-contract"
    | "complete-composition";
  readonly unitId: IrUnitId;
  readonly producer?: string;
  readonly occurrence?: number;
  readonly detail: string;
}

/** Locators into borrowed objects, including signatures, captures and recursive class layouts.
 * A cycle edge is recorded, but its descendants are not expanded a second time on that path. */
export type NativePromiseSourcePathStep =
  | PropertyKey
  | { readonly kind: "map-key" | "map-value" | "set-value"; readonly index: number };
export interface NativePromiseSourcePath {
  readonly root:
    | { readonly kind: "program" | "projection" | "support"; readonly index: number; readonly unitId: IrUnitId }
    | { readonly kind: "abi"; readonly index: number; readonly bindingId: IrBindingId }
    | { readonly kind: "allocations" };
  readonly path: readonly NativePromiseSourcePathStep[];
  readonly value: unknown;
}
/** Only the selected flags consumed by this descriptive sidecar; no coordinator facade. */
export interface NativePromiseInventoryOptions {
  readonly backend: PreparedIrProgramRuntimeProjection["backend"];
  readonly target: PreparedIrProgramRuntimeProjection["target"];
  readonly utf8Storage: boolean;
  readonly stringConcatEmptyIdentity?: boolean;
}
interface NativePromiseSourceCensusEvidence {
  readonly program: PreparedIrProgram;
  readonly projection: PreparedIrProgramRuntimeProjection;
  readonly options: NativePromiseInventoryOptions;
  readonly demands: NativeStringValueDemands;
  readonly supportFunctions: readonly IrFunction[];
  readonly supportBuffers: readonly NativeStringValueBuffer[];
  readonly supportOccurrences: readonly NativeStringValueOccurrence[];
  readonly abiEntries: PreparedIrProgram["abi"]["entries"];
  readonly allocations: PreparedIrProgram["allocations"];
  readonly paths: readonly NativePromiseSourcePath[];
}
export type NativePromiseSourceCensus = NativePromiseSourceCensusEvidence &
  (
    | { readonly required: false; readonly anchorUnitId?: never }
    | { readonly required: true; readonly anchorUnitId: IrUnitId }
  );
const snapshots = new WeakMap<NativePromiseSourceCensus, unknown>();

/** Descriptive census only. The live coordinator authenticates the whole program before acting on it. */
export function collectNativePromiseSourceCensus(
  program: PreparedIrProgram,
  projection: PreparedIrProgramRuntimeProjection,
  options: NativePromiseInventoryOptions,
): NativePromiseSourceCensus {
  // This bounded collector uses the existing standalone buffer census. Callers on
  // other backends must establish their no-demand branch using their own selection.
  const demands = collectNativeStringValueDemands(program, projection);
  if (options.backend !== projection.backend || options.target !== projection.target)
    invalid("foreign selected options");
  const supportFunctions = irRuntimeSupportFunctions(program.runtimeSupport);
  const supportBuffers: NativeStringValueBuffer[] = [],
    supportOccurrences: NativeStringValueOccurrence[] = [];
  const active = new Set<readonly IrInstr[]>();
  const visit = (
    fn: IrFunction,
    root: NativeStringValueBuffer["root"],
    path: NativeStringValueBuffer["path"],
    instructions: readonly IrInstr[],
  ): void => {
    dense(instructions);
    if (active.has(instructions)) invalid("cyclic support buffer");
    active.add(instructions);
    const bufferIndex = supportBuffers.length;
    supportBuffers.push(
      Object.freeze({
        ownerUnitId: fn.unitId,
        view: "program",
        root: Object.freeze({ ...root }),
        path: Object.freeze(path.map((step) => Object.freeze({ ...step }))),
        instructions,
      }),
    );
    instructions.forEach((instruction, instructionIndex) => {
      supportOccurrences.push(Object.freeze({ bufferIndex, instructionIndex, instruction }));
      let childBufferIndex = 0;
      forEachNestedBuffer(instruction, (child) =>
        visit(
          fn,
          root,
          Object.freeze([...path, Object.freeze({ instructionIndex, childBufferIndex: childBufferIndex++ })]),
          child,
        ),
      );
    });
    active.delete(instructions);
  };
  dense(supportFunctions);
  supportFunctions.forEach((fn) => {
    dense(fn.blocks);
    fn.blocks.forEach((block, index) => visit(fn, { kind: "block", index, id: block.id }, [], block.instrs));
    if (fn.asyncPlan) {
      dense(fn.asyncPlan.states);
      fn.asyncPlan.states.forEach((state, index) =>
        visit(fn, { kind: "async-plan", index, id: state.id }, [], state.body),
      );
    }
  });
  const paths: NativePromiseSourcePath[] = [];
  const pathActive = new Set<object>();
  const record = (
    root: NativePromiseSourcePath["root"],
    value: unknown,
    path: readonly NativePromiseSourcePathStep[],
  ): void => {
    paths.push(Object.freeze({ root, path: Object.freeze(path), value }));
    if (value === null || typeof value !== "object" || pathActive.has(value)) return;
    pathActive.add(value);
    // Prepared source data uses own data fields, including symbol class-shape cells.
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!("value" in descriptor)) invalid("non-data source path");
      record(root, descriptor.value, [...path, key]);
    }
    if (value instanceof Map) {
      let index = 0;
      for (const [key, item] of Map.prototype.entries.call(value)) {
        record(root, key, [...path, Object.freeze({ kind: "map-key", index })]);
        record(root, item, [...path, Object.freeze({ kind: "map-value", index: index++ })]);
      }
    } else if (value instanceof Set) {
      let index = 0;
      for (const item of Set.prototype.values.call(value))
        record(root, item, [...path, Object.freeze({ kind: "set-value", index: index++ })]);
    }
    pathActive.delete(value);
  };
  demands.owners.forEach((owner, index) => {
    record(Object.freeze({ kind: "program", index, unitId: owner.unitId }), owner.programFunction, []);
    record(Object.freeze({ kind: "projection", index, unitId: owner.unitId }), owner.projectedFunction, []);
  });
  supportFunctions.forEach((fn, index) => record(Object.freeze({ kind: "support", index, unitId: fn.unitId }), fn, []));
  program.abi.entries.forEach((entry, index) =>
    record(Object.freeze({ kind: "abi", index, bindingId: entry.plan.id }), entry, []),
  );
  record(Object.freeze({ kind: "allocations" }), program.allocations, []);
  const required =
    demands.owners.some((owner) => owner.projectedFunction.asyncPlan !== undefined) ||
    projection.prepared.manifest.providers.some(
      (provider) =>
        provider.feature.startsWith("promise.") ||
        provider.feature.startsWith("scheduler.") ||
        provider.feature === "async.native.delay" ||
        provider.feature === "async.native.all",
    );
  // A re-export-only entry has no terminal of its own. No-demand collection
  // needs no diagnostic anchor; required demand uses an actual source terminal.
  const entry = program.inventory.sources.find((row) => row.kind === "entry");
  const anchorUnitId = required
    ? (program.inventory.terminalUnits.find((row) => row.sourceId === entry?.id) ?? program.inventory.terminalUnits[0])
        ?.id
    : undefined;
  if (required && !anchorUnitId) invalid("missing terminal source anchor for required demand");
  const selection = required ? { required: true as const, anchorUnitId: anchorUnitId! } : { required: false as const };
  const census = Object.freeze({
    program,
    projection,
    options,
    ...selection,
    demands,
    supportFunctions: Object.freeze(supportFunctions),
    supportBuffers: Object.freeze(supportBuffers),
    supportOccurrences: Object.freeze(supportOccurrences),
    abiEntries: program.abi.entries,
    allocations: program.allocations,
    paths: Object.freeze(paths),
  });
  snapshots.set(census, freezePreparedIrValue({ program, options }));
  return census;
}

/** Snapshot and borrowed-identity consistency, not whole-program admission or an acceptance capability. */
export function assertNativePromiseSourceCensusCurrent(census: NativePromiseSourceCensus): void {
  const snapshot = snapshots.get(census);
  if (!snapshot || preparedIrDataMismatch(snapshot, { program: census.program, options: census.options }) !== undefined)
    invalid("uncollected or stale source census");
  const fresh = collectNativePromiseSourceCensus(census.program, census.projection, census.options);
  if (
    fresh.supportFunctions.length !== census.supportFunctions.length ||
    fresh.supportFunctions.some((fn, i) => fn !== census.supportFunctions[i]) ||
    fresh.supportBuffers.length !== census.supportBuffers.length ||
    fresh.supportBuffers.some((row, i) => {
      const prior = census.supportBuffers[i];
      return (
        !prior ||
        row.instructions !== prior.instructions ||
        row.ownerUnitId !== prior.ownerUnitId ||
        row.view !== prior.view ||
        preparedIrDataMismatch(row.root, prior.root) !== undefined ||
        preparedIrDataMismatch(row.path, prior.path) !== undefined
      );
    }) ||
    fresh.supportOccurrences.length !== census.supportOccurrences.length ||
    fresh.supportOccurrences.some((row, i) => {
      const prior = census.supportOccurrences[i];
      return (
        !prior ||
        row.instruction !== prior.instruction ||
        row.bufferIndex !== prior.bufferIndex ||
        row.instructionIndex !== prior.instructionIndex
      );
    })
  )
    invalid("detached support buffer or occurrence association");
  if (
    fresh.paths.length !== census.paths.length ||
    fresh.paths.some(
      (row, i) =>
        !Object.is(row.value, census.paths[i]!.value) ||
        preparedIrDataMismatch(row.root, census.paths[i]!.root) !== undefined ||
        preparedIrDataMismatch(row.path, census.paths[i]!.path) !== undefined,
    )
  )
    invalid("detached source association");
}

export type CarrierEvidence =
  | { readonly kind: "source-occurrence"; readonly occurrence: number }
  | { readonly kind: "allocation"; readonly slot: AllocSiteId }
  | { readonly kind: "abi"; readonly bindingId: IrBindingId }
  | { readonly kind: "recipe"; readonly producer: number; readonly declaration: number };
export interface PromiseLookupFacts {
  readonly methods: readonly {
    readonly carrier: string;
    readonly target: IrFuncRef;
    readonly evidence: CarrierEvidence;
  }[];
  readonly accessors: readonly {
    readonly carrier: string;
    readonly getterGlobalKey: string;
    readonly evidence: CarrierEvidence;
  }[];
  readonly fields: readonly {
    readonly carrier: string;
    readonly fieldIndex: number;
    readonly evidence: CarrierEvidence;
  }[];
  readonly callableRoots: readonly {
    readonly carrier: string;
    readonly registrations: readonly { readonly producer: number; readonly requestId: string }[];
  }[];
}
/** Keep underlying field evidence; only the executable projection shadows it. */
export function nativePromiseUnshadowedFields(facts: PromiseLookupFacts): PromiseLookupFacts["fields"] {
  return facts.fields.filter((field) => !facts.methods.some((method) => method.carrier === field.carrier));
}

/** Ordered descriptive invocation join only; callers still need the real invocation owner. */
export function compareNativePromiseMethodCoverage(
  facts: PromiseLookupFacts,
  coverage: readonly { readonly carrier: string; readonly target: IrFuncRef }[],
): void {
  dense(coverage);
  if (
    preparedIrDataMismatch(
      facts.methods.map(({ carrier, target }) => ({ carrier, target })),
      coverage,
    ) !== undefined
  )
    invalid("missing or reordered invocation coverage");
}

export type ConstructionOp = "struct.new" | "array.new" | "array.new_fixed" | "array.new_default";
export interface ConstructionRoot {
  readonly space: "function" | "global";
  readonly key: string;
}
export interface ConstructionExpectation {
  readonly root: ConstructionRoot;
  readonly allocations: readonly { readonly op: ConstructionOp; readonly carrier: string }[];
}
