// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { forEachNestedBuffer, type IrFunction, type IrInstr } from "../../core/nodes.js";
import type { IrType } from "../../core/types.js";
import { copyIrPreparationData } from "../alloc-registry.js";
import { preparedIrDataMismatch } from "../../../shared/contracts/prepared-ir-data.js";
import { PreparedIrProgramInvariantError } from "../../../shared/contracts/prepared-ir-invariant-error.js";
import { IrUnsupportedError } from "../../../shared/contracts/ir-preparation-errors.js";
import { inspectOrdinaryNumberUndefinedNamespaces } from "./ordinary-number-undefined-profile.js";
import type { NativeNumberUndefinedLogicalContext } from "./native-number-undefined-legality.js";

export interface OrdinaryNumberUndefinedRepresentability {
  readonly kind: "native-ordinary-number-undefined-representability";
}
interface Record {
  context: NativeNumberUndefinedLogicalContext;
  snapshot: NativeNumberUndefinedLogicalContext;
  identities: readonly object[];
  instructions: ReadonlySet<IrInstr>;
}
const records = new WeakMap<OrdinaryNumberUndefinedRepresentability, Record>();
function fail(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", "ordinary representation: " + detail);
}
function field(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") fail("foreign use");
  const d = Object.getOwnPropertyDescriptor(value, key);
  if (!d || !("value" in d)) fail("non-DATA use");
  return d.value;
}
function inspect(context: NativeNumberUndefinedLogicalContext): boolean {
  copyIrPreparationData(context);
  if (
    Reflect.ownKeys(context).length !== 5 ||
    !["original", "selected", "registry", "function", "backend"].every((k) => Object.hasOwn(context, k))
  )
    fail("context fields");
  if (context.backend !== "wasmgc" && context.backend !== "linear") fail("backend");
  if (!context.selected.functions.includes(context.function)) fail("selected function membership");
  const reports = [context.original, context.selected].map((module) =>
    inspectOrdinaryNumberUndefinedNamespaces(module, context.registry),
  );
  for (const report of reports) if (report?.kind === "invalid") fail("independent replay " + report.code);
  if (reports.every((r) => r === undefined)) return false;
  for (const report of reports)
    if (report?.kind !== "representable" || report.namespaces !== "ownership-and-escape")
      throw new IrUnsupportedError(
        "array-representation-unsupported",
        "resolve",
        "ordinary representation requires original/selected complete evidence",
      );
  return true;
}
function identities(context: NativeNumberUndefinedLogicalContext): object[] {
  const values: object[] = [],
    seen = new Set<object>();
  const walk = (value: unknown) => {
    if (value === null || typeof value !== "object") return;
    values.push(value);
    if (seen.has(value)) return;
    seen.add(value);
    if (value instanceof Map) {
      for (const [k, v] of value) {
        walk(k);
        walk(v);
      }
    } else if (value instanceof Set) {
      for (const v of value) walk(v);
    } else
      for (const key of Reflect.ownKeys(value)) {
        const d = Object.getOwnPropertyDescriptor(value, key);
        if (!d || !("value" in d)) fail("identity DATA");
        walk(d.value);
      }
  };
  walk(context.original);
  for (const fn of context.selected.functions) walk(fn);
  walk(context.registry);
  walk(context.function);
  return values;
}
function instructions(fn: IrFunction): Set<IrInstr> {
  const found = new Set<IrInstr>();
  const walk = (buffer: readonly IrInstr[]) => {
    for (const instr of buffer) {
      found.add(instr);
      forEachNestedBuffer(instr, walk);
    }
  };
  for (const block of fn.blocks) walk(block.instrs);
  return found;
}
export function issueOrdinaryNumberUndefinedRepresentability(
  context: NativeNumberUndefinedLogicalContext,
): OrdinaryNumberUndefinedRepresentability | undefined {
  if (!inspect(context)) return undefined;
  const proof = Object.freeze({ kind: "native-ordinary-number-undefined-representability" } as const);
  records.set(proof, {
    context: { ...context },
    snapshot: copyIrPreparationData(context),
    identities: identities(context),
    instructions: instructions(context.function),
  });
  return proof;
}
export function assertOrdinaryNumberUndefinedLegalityCurrent(
  proof: OrdinaryNumberUndefinedRepresentability,
  context: NativeNumberUndefinedLogicalContext,
  fn: IrFunction,
  backend: string,
): void {
  const record = records.get(proof);
  if (!record) fail("unissued/copied token");
  copyIrPreparationData(context);
  if (
    context.original !== record.context.original ||
    context.registry !== record.context.registry ||
    context.selected.functions !== record.context.selected.functions ||
    context.function !== fn ||
    fn !== record.context.function ||
    context.backend !== backend ||
    backend !== record.context.backend ||
    preparedIrDataMismatch(record.snapshot, context) !== undefined
  )
    fail("stale/foreign body/signature/backend");
  const current = identities(context);
  if (current.length !== record.identities.length || current.some((v, i) => v !== record.identities[i]))
    fail("changed current identity");
  if (!inspect(context)) fail("population vanished");
}
function checked(
  proof: OrdinaryNumberUndefinedRepresentability,
  context: NativeNumberUndefinedLogicalContext,
  fn: IrFunction,
  backend: string,
): Record {
  assertOrdinaryNumberUndefinedLegalityCurrent(proof, context, fn, backend);
  return records.get(proof)!;
}
export function ordinaryNumberUndefinedSignatureResultIsAdmitted(
  proof: OrdinaryNumberUndefinedRepresentability,
  context: NativeNumberUndefinedLogicalContext,
  fn: IrFunction,
  backend: string,
  index: number,
  type: IrType,
): boolean {
  checked(proof, context, fn, backend);
  return (
    Number.isSafeInteger(index) &&
    index >= 0 &&
    index < fn.resultTypes.length &&
    fn.resultTypes[index] === type &&
    type.kind === "dynamic"
  );
}
export function ordinaryNumberUndefinedInstructionTypeIsAdmitted(
  proof: OrdinaryNumberUndefinedRepresentability,
  context: NativeNumberUndefinedLogicalContext,
  fn: IrFunction,
  backend: string,
  instr: IrInstr,
  type: IrType,
): boolean {
  const record = checked(proof, context, fn, backend);
  if (!record.instructions.has(instr)) return false;
  const actual =
    instr.kind === "box"
      ? type === instr.toType || type === instr.resultType
      : ["const", "call", "if"].includes(instr.kind) && type === instr.resultType;
  return actual && type.kind === "dynamic";
}
export function ordinaryNumberUndefinedCarrierInstructionIsAdmitted(
  proof: OrdinaryNumberUndefinedRepresentability,
  context: NativeNumberUndefinedLogicalContext,
  fn: IrFunction,
  backend: string,
  instr: IrInstr,
): instr is Extract<IrInstr, { kind: "const" | "box" | "tag.test" | "dyn.eq" | "dyn.to_number" }> {
  const record = checked(proof, context, fn, backend);
  if (!record.instructions.has(instr)) return false;
  return (
    instr.kind === "box" ||
    instr.kind === "tag.test" ||
    instr.kind === "dyn.eq" ||
    instr.kind === "dyn.to_number" ||
    (instr.kind === "const" && instr.resultType?.kind === "dynamic")
  );
}
/** Dispatch tests issuance, never an outsider discriminant getter. */
export function isIssuedOrdinaryNumberUndefinedProof(value: unknown): value is OrdinaryNumberUndefinedRepresentability {
  return typeof value === "object" && value !== null && records.has(value as OrdinaryNumberUndefinedRepresentability);
}
