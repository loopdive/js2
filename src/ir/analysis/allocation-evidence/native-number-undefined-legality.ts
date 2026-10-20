// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { forEachNestedBuffer, type IrFunction, type IrInstr, type IrModule } from "../../core/nodes.js";
import type { IrType } from "../../core/types.js";
import type { IrBackendNativeAdmission } from "../backend-legality.js";
import type { AllocRegistrySnapshot } from "../contracts/allocations.js";
import { copyIrPreparationData } from "../alloc-registry.js";
import {
  inspectNativeNumberUndefinedBodies,
  type NativeNumberUndefinedRequirements,
} from "./native-number-undefined-body.js";
import { inspectNativeNumberUndefinedNamespaces } from "./native-number-undefined-profile.js";
import { preparedIrDataMismatch } from "../../../shared/contracts/prepared-ir-data.js";
import { PreparedIrProgramInvariantError } from "../../../shared/contracts/prepared-ir-invariant-error.js";
import { IrUnsupportedError } from "../../../shared/contracts/ir-preparation-errors.js";

/** Representability of two closed partitions; never canonical JS or physical authority. */
export interface NativeNumberUndefinedRepresentability {
  readonly kind: "native-number-undefined-representability";
}
export interface NativeNumberUndefinedLogicalContext {
  readonly original: IrModule;
  readonly selected: IrModule;
  readonly registry: AllocRegistrySnapshot;
  readonly function: IrFunction;
  readonly backend: "wasmgc" | "linear";
}
export interface NativeNumberUndefinedLegalityUse {
  readonly proof: NativeNumberUndefinedRepresentability;
  readonly context: NativeNumberUndefinedLogicalContext;
}
type NativeInstruction = Extract<IrInstr, { kind: "const" | "box" | "tag.test" | "dyn.eq" | "dyn.to_number" }>;
interface Issued {
  readonly context: NativeNumberUndefinedLogicalContext;
  readonly functions: readonly IrFunction[];
  readonly snapshot: NativeNumberUndefinedLogicalContext;
  readonly census: NativeNumberUndefinedRequirements;
  readonly instructions: ReadonlySet<IrInstr>;
  readonly identities: readonly object[];
}
const issued = new WeakMap<NativeNumberUndefinedRepresentability, Issued>();
function invalid(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", "native representation proof: " + detail);
}
function data(value: unknown): void {
  try {
    copyIrPreparationData(value);
  } catch {
    invalid("context must be complete descriptor DATA");
  }
}
function checkContext(context: NativeNumberUndefinedLogicalContext): void {
  data(context);
  const fields = ["original", "selected", "registry", "function", "backend"];
  if (!context || typeof context !== "object" || Reflect.ownKeys(context).length !== fields.length)
    invalid("unknown or absent logical context fields");
  for (const field of fields) own(context, field);
  if (
    !context.original ||
    !context.selected ||
    !context.registry ||
    !context.function ||
    !Array.isArray(context.original.functions) ||
    !Array.isArray(context.selected.functions) ||
    !Array.isArray(context.registry.entries) ||
    !Array.isArray(context.registry.metadata) ||
    !Number.isSafeInteger(context.registry.size) ||
    context.registry.size !== context.registry.entries.length
  )
    invalid("incomplete module/registry/function context");
}
function inspect(context: NativeNumberUndefinedLogicalContext): NativeNumberUndefinedRequirements | undefined {
  if (context.backend !== "wasmgc" && context.backend !== "linear") invalid("unsupported backend");
  if (!context.selected.functions.includes(context.function)) invalid("function is not an actual selected member");
  const original = inspectNativeNumberUndefinedBodies(context.original, context.registry);
  const selected = inspectNativeNumberUndefinedBodies(context.selected, context.registry);
  if (Boolean(original) !== Boolean(selected)) invalid("original/selected population differs");
  if (!selected) return undefined;
  if (!selected.units.includes(context.function.unitId)) invalid("function has no certified unit");
  for (const module of [context.original, context.selected]) {
    const report = inspectNativeNumberUndefinedNamespaces(module, context.registry);
    if (report?.kind === "invalid") invalid("independent namespace replay " + report.code);
    if (!report || report.kind !== "representable" || report.namespaces !== "ownership-and-escape")
      throw new IrUnsupportedError(
        "array-representation-unsupported",
        "resolve",
        "closed representation requires complete independent ownership and escape namespaces",
      );
  }
  return selected;
}
function instructions(fn: IrFunction): ReadonlySet<IrInstr> {
  const found = new Set<IrInstr>();
  const visit = (buffer: readonly IrInstr[]) => {
    for (const instr of buffer) {
      found.add(instr);
      forEachNestedBuffer(instr, visit);
    }
  };
  for (const block of fn.blocks) visit(block.instrs);
  return found;
}
/** Preserve actual nested type/site/body identities while permitting a fresh selected wrapper. */
function identities(context: NativeNumberUndefinedLogicalContext): readonly object[] {
  const found: object[] = [],
    seen = new Set<object>();
  const visit = (value: unknown, omitRoot = false): void => {
    if (value === null || typeof value !== "object") return;
    if (!omitRoot) found.push(value);
    if (seen.has(value)) return;
    seen.add(value);
    if (value instanceof Map) {
      for (const [key, entry] of value) {
        visit(key);
        visit(entry);
      }
    } else if (value instanceof Set) {
      for (const entry of value) visit(entry);
    } else {
      for (const key of Reflect.ownKeys(value)) {
        const field = Object.getOwnPropertyDescriptor(value, key);
        if (!field || !("value" in field)) invalid("identity fields must be own DATA");
        visit(field.value);
      }
    }
  };
  visit(context.original);
  visit(context.selected, true);
  visit(context.registry);
  visit(context.function);
  return found;
}
/** A caller's callbacks, DATA shape, metadata or copied token cannot issue this proof. */
export function issueNativeNumberUndefinedRepresentability(
  context: NativeNumberUndefinedLogicalContext,
): NativeNumberUndefinedRepresentability | undefined {
  checkContext(context);
  const census = inspect(context);
  if (!census) return undefined;
  const proof = Object.freeze({ kind: "native-number-undefined-representability" } as const);
  issued.set(proof, {
    context: { ...context },
    functions: context.selected.functions,
    snapshot: copyIrPreparationData(context),
    census,
    instructions: instructions(context.function),
    identities: identities(context),
  });
  return proof;
}
function own(value: unknown, name: string): unknown {
  if (!value || typeof value !== "object") invalid("unissued use envelope");
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (!descriptor || !("value" in descriptor)) invalid("use fields must be own DATA");
  return descriptor.value;
}
function current(use: NativeNumberUndefinedLegalityUse, fn: IrFunction, backend: string): Issued {
  const proof = own(use, "proof") as NativeNumberUndefinedRepresentability;
  const record = issued.get(proof);
  if (!record) invalid("unissued or copied proof");
  const context = own(use, "context") as NativeNumberUndefinedLogicalContext;
  checkContext(context);
  if (
    context.original !== record.context.original ||
    context.registry !== record.context.registry ||
    context.selected.functions !== record.functions ||
    context.function !== record.context.function ||
    context.function !== fn ||
    context.backend !== record.context.backend ||
    context.backend !== backend ||
    preparedIrDataMismatch(record.snapshot, context) !== undefined
  )
    invalid("stale or foreign module/function/signature/backend context");
  const actualIdentities = identities(context);
  if (
    actualIdentities.length !== record.identities.length ||
    actualIdentities.some((value, i) => value !== record.identities[i])
  )
    invalid("actual body/site/type/evidence identities changed");
  const census = inspect(context);
  if (
    !census ||
    preparedIrDataMismatch(record.census, census) !== undefined ||
    census.occurrences.length !== record.census.occurrences.length ||
    census.occurrences.some((at, i) => at.instr !== record.census.occurrences[i]!.instr) ||
    census.boxes.some((at, i) => at.instr !== record.census.boxes[i]?.instr)
  )
    invalid("ordered current occurrence/site/type census changed");
  const actual = instructions(fn);
  if (actual.size !== record.instructions.size || [...actual].some((instr) => !record.instructions.has(instr)))
    invalid("actual instruction identities changed");
  return record;
}
export function assertNativeNumberUndefinedLegalityCurrent(
  use: NativeNumberUndefinedLegalityUse,
  fn: IrFunction,
  backend: string,
): void {
  current(use, fn, backend);
}
export function nativeNumberUndefinedInstructionIsAdmitted(
  use: NativeNumberUndefinedLegalityUse,
  fn: IrFunction,
  backend: string,
  instr: IrInstr,
): instr is NativeInstruction {
  const record = current(use, fn, backend);
  return record.census.occurrences.some((at) => at.unitId === fn.unitId && at.instr === instr);
}
/** Only the actual checked definition's field; no signature, slot, call or global grant. */
export function nativeNumberUndefinedTypeIsAdmitted(
  use: NativeNumberUndefinedLegalityUse,
  fn: IrFunction,
  backend: string,
  instr: IrInstr,
  type: IrType,
): boolean {
  const record = current(use, fn, backend);
  if (!record.instructions.has(instr)) return false;
  const field =
    instr.kind === "box"
      ? type === instr.resultType || type === instr.toType
      : (instr.kind === "const" || instr.kind === "if") && type === instr.resultType;
  // Outsider values are opaque until strict identity proves an actual current DATA field.
  return field && type !== null && type !== undefined && type.kind === "dynamic";
}

/** The verifier's injected view of one issued use (#3518 lowering-cycle pin: no value edge from the verifier). */
export function nativeNumberUndefinedAdmission(use: NativeNumberUndefinedLegalityUse): IrBackendNativeAdmission {
  return Object.freeze({
    assertCurrent: (fn: IrFunction, backend: string) => assertNativeNumberUndefinedLegalityCurrent(use, fn, backend),
    instructionIsAdmitted: (fn: IrFunction, backend: string, instr: IrInstr) =>
      nativeNumberUndefinedInstructionIsAdmitted(use, fn, backend, instr),
    typeIsAdmitted: (fn: IrFunction, backend: string, instr: IrInstr, type: IrType) =>
      nativeNumberUndefinedTypeIsAdmitted(use, fn, backend, instr, type),
  });
}
