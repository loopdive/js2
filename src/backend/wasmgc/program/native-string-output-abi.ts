// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irCallableBindingKey, irIntrinsicFuncRef } from "../../../ir/core/callable-bindings.js";
import { IR_STRING_CONCAT_FN, irStringConcatManySymbol } from "../../../ir/core/string-callables.js";
import { IR_ASYNC_STRING_CONCAT_5_FN } from "../../../ir/core/async-callables.js";
import type { IrType } from "../../../ir/core/types.js";
import { nativeAsyncCallableValueTypes } from "../../../ir/runtime/native-async-callables.js";
import { preparedIrCallableSignature } from "../../../ir/program/abi-signatures.js";
import {
  preparedIrRuntimeAbiAnchor,
  preparedIrRuntimeCallableBindingId,
} from "../../../ir/program/runtime-abi-identity.js";
import type { IrFuncRef } from "../../../ir/core/value-references.js";
import type { NativeStringOutputPhysicalPlan } from "./native-string-output.js";
import { nativeStringTypeKeys } from "../resources/native-string-literals.js";
import {
  assertNativeStringOutputRequirementsCurrent,
  type NativeStringOutputRequirements,
} from "../../../ir/program/native-string-output-requirements.js";
import { ProgramAbiMap, type ProgramAbiPlanEntry } from "../../../ir/program/abi.js";
import type { PreparedIrProgram } from "../../../ir/program/prepared-contracts.js";
import { preparedIrDataMismatch } from "../../../ir/program/data.js";
import { PreparedIrProgramInvariantError } from "../../../ir/program/errors.js";

interface NativeStringOutputAbiBinding {
  readonly resourceKey: string;
  readonly entry: ProgramAbiPlanEntry;
  readonly reference: IrFuncRef;
}

function fail(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", "native string output ABI: " + detail);
}
function same(actual: unknown, expected: unknown, detail: string): void {
  if (preparedIrDataMismatch(actual, expected) !== undefined) fail(detail);
}

type RequiredEntry = Extract<ProgramAbiPlanEntry, { readonly slotPolicy: "required" }>;

function existingOutputEntry(
  program: PreparedIrProgram,
  reference: IrFuncRef,
  expected: RequiredEntry,
  allowAlias: boolean,
): ProgramAbiPlanEntry | undefined {
  const previous = program.abi.entries.find((row) => row.plan.id === expected.id);
  if (!previous) return undefined;
  const { slotSpace: _slotSpace, ...alias } = expected;
  same(
    previous.plan,
    {
      ...(allowAlias && previous.plan.slotPolicy === "alias"
        ? { ...alias, slotPolicy: "alias", aliasOf: previous.plan.aliasOf }
        : expected),
      order: previous.plan.order,
      displayName: previous.plan.displayName,
    },
    "existing output ABI intent differs",
  );
  if (previous.contract.kind !== "callable" || Object.hasOwn(previous.contract, "promise"))
    fail("output ABI is not a synchronous callable");
  same(previous.contract.ref.binding, reference.binding, "existing output binding differs");
  if (expected.intent.kind !== "callable") fail("output intent is not callable");
  same(
    preparedIrCallableSignature(previous.contract.params, previous.contract.results),
    expected.intent.signature,
    "existing output signature differs",
  );
  return previous.plan;
}

/** Only this canonical pair denotes the same prescribed batch-five helper. */
function joinFivePartBindings(
  program: PreparedIrProgram,
  bindings: Map<string, NativeStringOutputAbiBinding>,
): readonly NativeStringOutputAbiBinding[] {
  const references = [irIntrinsicFuncRef(IR_ASYNC_STRING_CONCAT_5_FN), irIntrinsicFuncRef(irStringConcatManySymbol(5))];
  const referenceKeys = references.map((reference) => irCallableBindingKey(reference.binding));
  const group = [...bindings.values()].filter((binding) =>
    referenceKeys.includes(irCallableBindingKey(binding.reference.binding)),
  );
  if (!group.length) return Object.freeze([...bindings.values()]);
  const first = group[0]!;
  const intent = first.entry.intent;
  if (intent.kind !== "callable") fail("batch-five owner is not callable");
  const expected = (reference: IrFuncRef): RequiredEntry => ({
    id: preparedIrRuntimeCallableBindingId(program.inventory, reference),
    order: first.entry.order,
    displayName: reference.name,
    structuralReferenceKey: irCallableBindingKey(reference.binding),
    slotPolicy: "required",
    slotSpace: "function",
    intent,
  });
  for (const binding of group) {
    same(binding.resourceKey, first.resourceKey, "equivalent batch-five refs target different resources");
    same(binding.entry.intent, first.entry.intent, "equivalent batch-five refs have different contracts");
  }
  // A declared owner wins even if the other spelling occurs first (or alone).
  const existing = references.flatMap((reference) => {
    const entry = existingOutputEntry(program, reference, expected(reference), true);
    return entry ? [entry] : [];
  });
  let owner = first.entry,
    ownerReference = first.reference;
  if (existing.length) {
    const abi = new ProgramAbiMap(program.inventory, program.derivedUnits);
    for (const row of program.abi.entries) abi.plan(row.plan);
    abi.sealPlan();
    const ids = new Set(existing.map((entry) => abi.canonicalId(entry.id)));
    if (ids.size !== 1) fail("batch-five refs have competing existing required owners");
    const id = [...ids][0]!;
    const root = program.abi.entries.find((row) => row.plan.id === id);
    if (!root || root.contract.kind !== "callable") fail("batch-five alias has no callable owner");
    const rootReference = root.contract.ref;
    const reference = references.find(
      (candidate) => irCallableBindingKey(candidate.binding) === irCallableBindingKey(rootReference.binding),
    );
    if (!reference) fail("batch-five alias targets an unrelated required owner");
    owner = existingOutputEntry(program, reference, expected(reference), false) ?? fail("missing batch-five owner");
    if (owner.slotPolicy !== "required" || owner.slotSpace !== "function")
      fail("batch-five owner has no function slot");
    ownerReference = root.contract.ref;
  }
  for (const binding of group)
    bindings.set(irCallableBindingKey(binding.reference.binding), { ...binding, entry: owner });
  const ownerKey = irCallableBindingKey(ownerReference.binding);
  if (!bindings.has(ownerKey))
    bindings.set(ownerKey, { resourceKey: first.resourceKey, entry: owner, reference: ownerReference });
  return Object.freeze([...bindings.values()]);
}

/** Realize only authenticated output occurrences; logical strings retain their semantic ABI. */
export function nativeStringOutputAbiBindings(
  requirements: NativeStringOutputRequirements,
  plan: NativeStringOutputPhysicalPlan,
  declarationOrder: number,
): readonly NativeStringOutputAbiBinding[] {
  assertNativeStringOutputRequirementsCurrent(requirements);
  const { program, projection } = requirements.demands;
  same(plan.options, requirements.options, "physical option differs from admitted requirements");
  const anchor = preparedIrRuntimeAbiAnchor(program.inventory);
  const keys = nativeStringTypeKeys(plan.stringKey);
  const bindings = new Map<string, NativeStringOutputAbiBinding>();
  for (const use of requirements.uses) {
    const occurrence = requirements.demands.occurrences[use.occurrence]!;
    const buffer = requirements.demands.buffers[occurrence.bufferIndex]!;
    if (buffer.view !== "projection") continue;
    const instruction = occurrence.instruction;
    const reference =
      instruction.kind === "string.concat"
        ? (instruction.provider ?? irIntrinsicFuncRef(IR_STRING_CONCAT_FN))
        : instruction.kind === "call"
          ? instruction.target
          : undefined;
    if (!reference || reference.binding.kind !== "intrinsic") fail("output occurrence lost its semantic callable");
    const role =
      use.kind === "binary-concat"
        ? ["output", "concat"]
        : use.kind === "batched-concat"
          ? ["output", "batch", String(use.arity)]
          : ["output", "stdout-append"];
    const declarations = plan.declarations.filter((row) => preparedIrDataMismatch(row.role, role) === undefined);
    if (declarations.length !== 1 || declarations[0]!.space !== "function")
      fail("missing unique output callable declaration");
    const declaration = declarations[0]!;
    if (declaration.space !== "function") fail("output callable is not a function");
    const fn = projection.prepared.functions.find((row) => row.unitId === buffer.ownerUnitId);
    if (!fn) fail("output occurrence has no physical owner");
    const types = nativeAsyncCallableValueTypes(fn);
    const args =
      instruction.kind === "string.concat"
        ? [instruction.lhs, instruction.rhs]
        : instruction.kind === "call"
          ? instruction.args
          : [];
    const params = args.map((id): IrType => {
      const type = types.get(id);
      if (type?.kind !== "string") fail("output argument lost its logical string type");
      return type;
    });
    const results: IrType[] =
      instruction.result === null
        ? []
        : instruction.resultType
          ? [instruction.resultType]
          : fail("output result has no logical type");
    if (results.some((type) => type.kind !== "string")) fail("output result is not a logical string");
    // Generic provider externref signatures are not the native calling convention.
    // The accepted source contract is string-only; realize each argument explicitly
    // through this aggregate's issued AnyString declaration, with append widening only.
    same(
      declaration.signature,
      {
        params: params.map(() => ({ kind: use.kind === "stdout-append" ? "ref_null" : "ref", typeKey: keys.any })),
        results: results.map(() => ({ kind: "ref", typeKey: keys.any })),
      },
      "output recipe differs from its logical-to-native carrier realization",
    );
    const signature = preparedIrCallableSignature(params, results);
    const id = preparedIrRuntimeCallableBindingId(program.inventory, reference);
    const entry: ProgramAbiPlanEntry = {
      id,
      order: { sourceOrder: anchor.order, declarationOrder: declarationOrder + plan.declarations.indexOf(declaration) },
      displayName: reference.name,
      structuralReferenceKey: irCallableBindingKey(reference.binding),
      slotPolicy: "required",
      slotSpace: "function",
      intent: { kind: "callable", origin: "intrinsic", signature },
    };
    const previous = existingOutputEntry(program, reference, entry, use.kind === "batched-concat" && use.arity === 5);
    const key = irCallableBindingKey(reference.binding);
    const binding = { resourceKey: declaration.key, entry: previous ?? entry, reference };
    const retained = bindings.get(key);
    if (retained) same(retained, binding, "one output callable has contradictory realizations");
    else bindings.set(key, binding);
  }
  return joinFivePartBindings(program, bindings);
}
