// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irCallableBindingKey, irIntrinsicFuncRef } from "../core/callable-bindings.js";
import type { IrFunction, IrInstr, IrInstrCall, IrValueId } from "../core/nodes.js";
import { irTypeEquals, type IrType } from "../core/types.js";
import type { IrFuncRef } from "../core/value-references.js";
import { IR_STRING_CONCAT_FN, irStringConcatManySymbol } from "../core/string-callables.js";
import { STRING_CONCAT_RUNTIME_PROVIDERS, STRING_CONCAT_MANY_RUNTIME_PROVIDERS } from "../runtime/manifest.js";
import {
  NATIVE_ASYNC_CALLABLE_DECLARATIONS,
  NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDERS,
  nativeAsyncCallMismatch,
  nativeAsyncCallableValueTypes,
  nativeAsyncCallablePolicyMismatch,
} from "../runtime/native-async-callables.js";
import type { IrRuntimeCallableDeclaration } from "../runtime/callable-declarations.js";
import { STRING_CONCAT_MANY_NATIVE_ARITY, type RuntimeProviderDefinition } from "../runtime/contracts/manifest.js";
import type { PreparedIrProgramFailure } from "./prepared-contracts.js";
import { collectNativeStringValueDemands, type NativeStringValueDemands } from "./native-string-value-demands.js";
import { freezePreparedIrValue, preparedIrDataMismatch } from "./data.js";
import { PreparedIrProgramInvariantError } from "./errors.js";

export interface NativeStringOutputOptions {
  readonly emptyIdentity: boolean;
}
export type NativeStringOutputUse =
  | { readonly occurrence: number; readonly kind: "binary-concat" }
  | { readonly occurrence: number; readonly kind: "batched-concat"; readonly arity: number }
  | { readonly occurrence: number; readonly kind: "stdout-append" };
export interface NativeStringOutputRequirements {
  readonly demands: NativeStringValueDemands;
  readonly options: NativeStringOutputOptions;
  readonly uses: readonly NativeStringOutputUse[];
  readonly binaryConcat: boolean;
  readonly batchArities: readonly number[];
  readonly stdout: boolean;
}

interface IssuedRequirements {
  readonly demands: NativeStringValueDemands;
  readonly options: NativeStringOutputOptions;
  readonly snapshot: unknown;
  readonly metadataCurrent: readonly (() => boolean)[];
}
const issued = new WeakMap<NativeStringOutputRequirements, IssuedRequirements>();

function fail(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", `native string output requirements: ${detail}`);
}
function same(left: unknown, right: unknown, detail: string): void {
  if (preparedIrDataMismatch(left, right) !== undefined) fail(detail);
}
function declaration(feature: IrRuntimeCallableDeclaration["feature"]): IrRuntimeCallableDeclaration {
  const rows = NATIVE_ASYNC_CALLABLE_DECLARATIONS.filter((row) => row.feature === feature);
  if (rows.length !== 1) fail("missing canonical output declaration");
  return rows[0]!;
}
const batchDeclaration = declaration("js.string.concat.many");
const stdoutDeclaration = declaration("async.native.console-append");

function locate(demands: NativeStringValueDemands, occurrence: number, detail: string): PreparedIrProgramFailure {
  const row = demands.occurrences[occurrence];
  const id = row && demands.buffers[row.bufferIndex]?.ownerUnitId;
  const program = demands.program;
  const unit = program.inventory.allUnits.find((candidate) => candidate.id === id);
  const derived = program.derivedUnits.find((candidate) => candidate.id === id);
  const owner = program.inventory.terminalUnits.find(
    (candidate) => candidate.id === (derived?.terminalOwnerId ?? unit?.terminalOwnerId ?? id),
  );
  const source = owner && program.inventory.sources.find((candidate) => candidate.id === owner.sourceId);
  if (!owner || !source) fail("cannot locate output occurrence");
  return Object.freeze({
    kind: "unsupported",
    code: "body-shape-rejected",
    stage: "build",
    detail,
    unitId: owner.id,
    sourceFile: source.sourceKey,
    location: Object.freeze({
      sourceId: owner.sourceId,
      line: owner.line,
      column: owner.column,
      declarationStart: owner.declarationStart,
      declarationEnd: owner.declarationEnd,
    }),
  });
}

function authenticateCensus(demands: NativeStringValueDemands): void {
  const current = collectNativeStringValueDemands(demands.program, demands.projection);
  same(demands, current, "stale or mismatched complete occurrence census");
  const expected = [...demands.program.inventory.terminalUnits, ...demands.program.derivedUnits].map((row) => row.id);
  if (
    new Set(expected).size !== expected.length ||
    expected.length !== demands.owners.length ||
    expected.some((id) => !demands.owners.some((owner) => owner.unitId === id))
  )
    fail("missing or extra original/derived output owner");
  if (
    demands.allocations !== demands.program.allocations ||
    current.owners.some(
      (row, index) =>
        row.programFunction !== demands.owners[index]?.programFunction ||
        row.projectedFunction !== demands.owners[index]?.projectedFunction,
    ) ||
    current.buffers.some((row, index) => row.instructions !== demands.buffers[index]?.instructions) ||
    current.occurrences.some((row, index) => row.instruction !== demands.occurrences[index]?.instruction) ||
    current.literals.some((row, index) => {
      const old = demands.literals[index];
      return (
        row.kind === "string.const" &&
        (old?.kind !== "string.const" ||
          (row.allocation.metadataRow.present &&
            (!old.allocation.metadataRow.present ||
              row.allocation.metadataRow.value !== old.allocation.metadataRow.value)) ||
          (row.allocation.encoding.present &&
            (!old.allocation.encoding.present || row.allocation.encoding.value !== old.allocation.encoding.value)))
      );
    })
  )
    fail("detached borrowed instruction, owner or allocation evidence");
}

function selectedProvider(demands: NativeStringValueDemands, canonical: RuntimeProviderDefinition): void {
  const manifest = demands.projection.prepared.manifest;
  const rows = manifest.providers.filter((row) => row.feature === canonical.feature);
  if (rows.length !== 1) fail(`missing or duplicate ${canonical.feature} provider`);
  same(rows[0], canonical, `${canonical.feature} provider differs from canonical definition`);
  if (!manifest.features.includes(canonical.feature)) fail("provider lacks its selected feature");
  const mismatch = nativeAsyncCallablePolicyMismatch(canonical.feature, manifest.policy);
  if (mismatch) fail(mismatch);
  if (
    (canonical.feature === "js.string.concat" || canonical.feature === "js.string.concat.many") &&
    manifest.policy.stringConcat?.concat !== "native"
  )
    fail("output requires explicit native concatenation");
}

function canonicalProvider(feature: RuntimeProviderDefinition["feature"]): RuntimeProviderDefinition {
  const rows = [
    ...STRING_CONCAT_RUNTIME_PROVIDERS,
    ...STRING_CONCAT_MANY_RUNTIME_PROVIDERS,
    ...NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDERS,
  ].filter(
    (row) =>
      row.feature === feature &&
      (row.implementation.kind === "runtime-callable" || row.implementation.kind === "runtime-callable-family"),
  );
  if (rows.length !== 1) fail("ambiguous canonical native output provider");
  return rows[0]!;
}

function exactReference(actual: IrFuncRef, expected: IrFuncRef): boolean {
  return irCallableBindingKey(actual.binding) === irCallableBindingKey(expected.binding);
}
function batchContract(call: IrInstrCall): IrRuntimeCallableDeclaration | undefined {
  if (exactReference(call.target, batchDeclaration.ref)) return batchDeclaration;
  for (let arity = STRING_CONCAT_MANY_NATIVE_ARITY.min; arity <= STRING_CONCAT_MANY_NATIVE_ARITY.max; arity++) {
    const ref = irIntrinsicFuncRef(irStringConcatManySymbol(arity));
    if (exactReference(call.target, ref))
      return { ...batchDeclaration, ref, params: Array.from({ length: arity }, () => batchDeclaration.params[0]!) };
  }
  return undefined;
}

function selectUse(
  demands: NativeStringValueDemands,
  occurrence: number,
  valueTypes: () => ReadonlyMap<IrValueId, IrType>,
): NativeStringOutputUse | PreparedIrProgramFailure | undefined {
  const row = demands.occurrences[occurrence]!;
  const instruction = row.instruction;
  if (instruction.kind === "string.concat") {
    if ((instruction.concatMode ?? "immutable") !== "immutable")
      return locate(demands, occurrence, "owned string concatenation has no immutable output resource join");
    selectedProvider(demands, canonicalProvider("js.string.concat"));
    const expected = irIntrinsicFuncRef(IR_STRING_CONCAT_FN);
    // Whole-program runtime preparation selects the manifest but does not attach
    // the compatibility string-support field. Validate any actual attachment;
    // an absent field keeps the canonical intrinsic operation representation.
    if (Object.hasOwn(instruction, "provider"))
      same(instruction.provider, expected, "binary concat has a noncanonical attachment");
    const types = valueTypes();
    if (
      instruction.result === null ||
      !instruction.resultType ||
      !irTypeEquals(instruction.resultType, batchDeclaration.results[0]!) ||
      [instruction.lhs, instruction.rhs].some(
        (value) => !types.has(value) || !irTypeEquals(types.get(value)!, batchDeclaration.params[0]!),
      )
    )
      return locate(demands, occurrence, "binary concat requires two logical strings and a nonnull string result");
    return Object.freeze({ occurrence, kind: "binary-concat" });
  }
  if (
    (instruction.kind.startsWith("string.") && instruction.kind !== "string.const") ||
    instruction.kind === "forof.string"
  )
    return locate(demands, occurrence, `${instruction.kind} has no native string output resource join`);
  if (instruction.kind !== "call") return undefined;
  const contract = exactReference(instruction.target, stdoutDeclaration.ref)
    ? stdoutDeclaration
    : batchContract(instruction);
  if (!contract) return undefined;
  same(instruction.target, contract.ref, "output call carries a noncanonical callable reference");
  selectedProvider(demands, canonicalProvider(contract.feature));
  const mismatch = nativeAsyncCallMismatch(instruction, contract, valueTypes());
  if (mismatch) return locate(demands, occurrence, `native string output call: ${mismatch}`);
  return contract === stdoutDeclaration
    ? Object.freeze({ occurrence, kind: "stdout-append" })
    : Object.freeze({ occurrence, kind: "batched-concat", arity: contract.params.length });
}

function coordinate(demands: NativeStringValueDemands, occurrence: number, view: string, runtime = false): string {
  const row = demands.occurrences[occurrence]!;
  const buffer = demands.buffers[row.bufferIndex]!;
  return JSON.stringify([
    buffer.ownerUnitId,
    view,
    runtime ? "async-plan" : buffer.root.kind,
    buffer.root.index,
    buffer.root.id,
    buffer.path,
    row.instructionIndex,
  ]);
}
function reconcileViews(
  demands: NativeStringValueDemands,
  selections: ReadonlyMap<number, NativeStringOutputUse>,
): void {
  const byCoordinate = new Map(
    demands.occurrences.map((_, index) => [
      coordinate(demands, index, demands.buffers[demands.occurrences[index]!.bufferIndex]!.view),
      index,
    ]),
  );
  for (const [index, use] of selections) {
    const buffer = demands.buffers[demands.occurrences[index]!.bufferIndex]!;
    const peerKey =
      buffer.root.kind === "async-runtime"
        ? coordinate(demands, index, "projection", true)
        : coordinate(demands, index, buffer.view === "program" ? "projection" : "program");
    const peerIndex = byCoordinate.get(peerKey);
    const peer = peerIndex === undefined ? undefined : selections.get(peerIndex);
    if (
      !peer ||
      peer.kind !== use.kind ||
      (peer.kind === "batched-concat" && (use.kind !== "batched-concat" || peer.arity !== use.arity))
    )
      fail("output occurrence differs across prepared views");
    const instruction = demands.occurrences[index]!.instruction;
    const peerInstruction = demands.occurrences[peerIndex!]!.instruction;
    if (
      buffer.view === "projection" &&
      instruction.kind === "string.concat" &&
      peerInstruction.kind === "string.concat" &&
      Object.hasOwn(peerInstruction, "provider") &&
      !Object.hasOwn(instruction, "provider")
    )
      fail("binary concat projection dropped an existing provider attachment");
    const stripAttachment = (instruction: IrInstr) => {
      if (instruction.kind !== "string.concat") return instruction;
      const { provider: _provider, ...semantic } = instruction;
      return semantic;
    };
    same(
      stripAttachment(demands.occurrences[index]!.instruction),
      stripAttachment(demands.occurrences[peerIndex!]!.instruction),
      "output instruction differs across prepared views",
    );
  }
}

/** Retain metadata identities as well as its lossless data snapshot. */
function metadataIdentityChecks(root: unknown): readonly (() => boolean)[] {
  const checks: (() => boolean)[] = [];
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) fail("metadata is not plain data");
      const borrowed = descriptor.value;
      checks.push(() => {
        const current = Object.getOwnPropertyDescriptor(value, key);
        return !!current && "value" in current && Object.is(current.value, borrowed);
      });
      visit(borrowed);
    }
    if (value instanceof Map) {
      const rows: [unknown, unknown][] = [...Map.prototype.entries.call(value)];
      checks.push(() => {
        const current = [...Map.prototype.entries.call(value)];
        return (
          current.length === rows.length &&
          current.every(([key, item], index) => Object.is(key, rows[index]![0]) && Object.is(item, rows[index]![1]))
        );
      });
      for (const [key, item] of rows) {
        visit(key);
        visit(item);
      }
    } else if (value instanceof Set) {
      const rows: unknown[] = [...Set.prototype.values.call(value)];
      checks.push(() => {
        const current = [...Set.prototype.values.call(value)];
        return current.length === rows.length && current.every((item, index) => Object.is(item, rows[index]));
      });
      for (const item of rows) visit(item);
    }
  };
  visit(root);
  return Object.freeze(checks);
}

function calculate(
  demands: NativeStringValueDemands,
  options: NativeStringOutputOptions,
): NativeStringOutputRequirements | PreparedIrProgramFailure {
  if (
    !options ||
    typeof options.emptyIdentity !== "boolean" ||
    Object.keys(options).length !== 1 ||
    !Object.hasOwn(options, "emptyIdentity")
  )
    fail("emptyIdentity must be explicitly resolved");
  authenticateCensus(demands);
  const selections = new Map<number, NativeStringOutputUse>();
  const types = new Map<IrFunction, ReadonlyMap<IrValueId, IrType>>();
  for (const [index, occurrence] of demands.occurrences.entries()) {
    const buffer = demands.buffers[occurrence.bufferIndex]!;
    const owner = demands.owners.find((candidate) => candidate.unitId === buffer.ownerUnitId)!;
    const fn = buffer.view === "program" ? owner.programFunction : owner.projectedFunction;
    const selected = selectUse(demands, index, () => {
      let found = types.get(fn);
      if (!found) {
        found = nativeAsyncCallableValueTypes(fn);
        types.set(fn, found);
      }
      return found;
    });
    if (selected?.kind === "unsupported" || selected?.kind === "invariant") return selected;
    if (selected) selections.set(index, selected);
  }
  reconcileViews(demands, selections);
  const uses = [...selections.values()].filter((use) => {
    const buffer = demands.buffers[demands.occurrences[use.occurrence]!.bufferIndex]!;
    return buffer.view === "projection" && buffer.root.kind !== "async-plan";
  });
  const batchArities = [...new Set(uses.flatMap((use) => (use.kind === "batched-concat" ? [use.arity] : [])))];
  return Object.freeze({
    demands,
    options: Object.freeze({ ...options }),
    uses: Object.freeze(uses),
    binaryConcat: uses.length > 0,
    batchArities: Object.freeze(batchArities),
    stdout: uses.some((use) => use.kind === "stdout-append"),
  });
}

/** Full prepared-program validation remains the coordinator's prerequisite. */
export function deriveNativeStringOutputRequirements(
  demands: NativeStringValueDemands,
  options: NativeStringOutputOptions,
): NativeStringOutputRequirements | PreparedIrProgramFailure {
  const result = calculate(demands, options);
  if ("demands" in result)
    issued.set(result, {
      demands,
      options,
      snapshot: freezePreparedIrValue(demands),
      metadataCurrent: metadataIdentityChecks(demands.allocations),
    });
  return result;
}

/** Re-derive from the exact borrowed census; a copied descriptive record is not issued authority. */
export function assertNativeStringOutputRequirementsCurrent(requirements: NativeStringOutputRequirements): void {
  const source = issued.get(requirements);
  if (!source || requirements.demands !== source.demands) fail("unissued or foreign output requirements");
  same(source.demands, source.snapshot, "borrowed program, instruction or metadata changed after selection");
  if (source.metadataCurrent.some((check) => !check())) fail("borrowed allocation metadata identity changed");
  const current = calculate(source.demands, source.options);
  if (!("demands" in current)) fail("output requirements are no longer supported");
  same(requirements, current, "stale output selections or options");
}
