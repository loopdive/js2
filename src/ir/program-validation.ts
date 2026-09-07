// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irCallableBindingKey, irUnitCallableBindingId } from "./callable-bindings.js";
import { irGlobalBindingKey, irTypeBindingKey } from "./abi-bindings.js";
import { irBindingKey } from "./declared-types.js";
import { forEachInstrDeep, type IrDeclaredSignature, type IrType } from "./nodes.js";
import { ProgramAbiMap } from "./program-abi.js";
import {
  preparedIrCallableSignature,
  preparedIrClassLayoutKey,
  preparedIrDataKey,
  preparedIrTypeKey,
} from "./program-abi-contracts.js";
import { assertPreparedIrProgramPopulation } from "./program-population.js";
import {
  preparedIrDataMismatch,
  PreparedIrProgramInvariantError,
  type PreparedIrAbiEntry,
  type PreparedIrProgram,
} from "./program.js";
import {
  prepareIrProgramRuntimeCallables,
  preparedIrRuntimeAbiAnchor,
  preparedIrRuntimeCallableBindingId,
} from "./program-runtime-abi.js";
import { verifyIrFunction } from "./verify.js";
import { assertPreparedIrClassLayouts } from "./program-class-layouts.js";
import { assertPreparedIrProgramAllocations } from "./program-allocations.js";
import {
  assertPreparedIrRuntimeProjection,
  assertPreparedIrSemanticRuntimeSeparation,
} from "./program-runtime-validation.js";

function invalid(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", detail);
}

function sameSignature(
  left: { readonly params: readonly string[]; readonly results: readonly string[] },
  right: { readonly params: readonly string[]; readonly results: readonly string[] },
): boolean {
  return (
    left.params.length === right.params.length &&
    left.results.length === right.results.length &&
    left.params.every((value, index) => value === right.params[index]) &&
    left.results.every((value, index) => value === right.results[index])
  );
}

function validateEntry(entry: PreparedIrAbiEntry, entries: ReadonlyMap<string, PreparedIrAbiEntry>): void {
  const { plan, contract } = entry;
  if (plan.intent.kind !== contract.kind) invalid(`ABI binding ${plan.id} contradicts its semantic contract kind`);
  if (contract.kind === "callable" && plan.intent.kind === "callable") {
    if (!sameSignature(plan.intent.signature, preparedIrCallableSignature(contract.params, contract.results)))
      invalid(`ABI binding ${plan.id} contradicts its complete callable signature`);
    const key = irCallableBindingKey(contract.ref.binding);
    if (plan.slotPolicy === "alias") {
      const target = entries.get(plan.aliasOf);
      if (target?.contract.kind !== "callable" || irCallableBindingKey(target.contract.ref.binding) !== key)
        invalid(`ABI alias ${plan.id} contradicts its exact callable target`);
      if (
        plan.intent.origin !== "module-alias" ||
        contract.ref.binding.kind !== "unit" ||
        plan.intent.targetUnitId !== contract.ref.binding.unitId
      )
        invalid(`ABI alias ${plan.id} contradicts its source unit`);
    } else {
      if (plan.structuralReferenceKey !== key) invalid(`ABI callable ${plan.id} has a contradictory reference payload`);
      const binding = contract.ref.binding;
      if (binding.kind === "unit") {
        if (
          plan.id !== irUnitCallableBindingId(binding.unitId) ||
          plan.intent.unitId !== binding.unitId ||
          plan.intent.origin !== "source"
        )
          invalid(`ABI callable ${plan.id} has a contradictory unit binding`);
      } else if (binding.kind === "support") {
        if (plan.id !== binding.bindingId || plan.intent.origin !== "support")
          invalid(`ABI callable ${plan.id} has a contradictory support binding`);
      } else {
        if (plan.intent.origin !== binding.kind) invalid(`ABI callable ${plan.id} has a contradictory provider origin`);
        if (
          binding.kind === "import" &&
          (binding.capabilityId !== plan.intent.capabilityId || binding.providerId !== plan.intent.providerId)
        )
          invalid(`ABI callable ${plan.id} has contradictory capability provenance`);
      }
    }
  } else if (contract.kind === "global" && plan.intent.kind === "global") {
    if (
      plan.id !== contract.ref.binding.bindingId ||
      plan.structuralReferenceKey !== irGlobalBindingKey(contract.ref.binding) ||
      plan.intent.valueType !== preparedIrTypeKey(contract.type) ||
      plan.intent.mutable !== contract.mutable ||
      plan.intent.origin !== contract.ref.binding.kind
    )
      invalid(`ABI global ${plan.id} contradicts its declared storage`);
  } else if (contract.kind === "export" && plan.intent.kind === "export") {
    if (
      plan.slotPolicy !== "alias" ||
      plan.aliasOf !== contract.targetId ||
      plan.intent.targetId !== contract.targetId ||
      plan.intent.externalName !== contract.externalName
    )
      invalid(`ABI export ${plan.id} contradicts its declared target`);
  } else if (
    (contract.kind === "type" || contract.kind === "class") &&
    (plan.intent.kind === "type" || plan.intent.kind === "class")
  ) {
    if (
      plan.id !== contract.ref.binding.bindingId ||
      plan.structuralReferenceKey !== irTypeBindingKey(contract.ref.binding)
    )
      invalid(`ABI layout ${plan.id} contradicts its declared reference`);
    if (
      contract.kind === "type" &&
      plan.intent.kind === "type" &&
      plan.intent.shapeKey !== preparedIrTypeKey(contract.type)
    )
      invalid(`ABI type ${plan.id} contradicts its declared shape`);
    if (
      contract.kind === "class" &&
      plan.intent.kind === "class" &&
      (contract.ref.binding.kind !== "class" ||
        contract.ref.binding.classId !== contract.shape.classId ||
        plan.intent.classId !== contract.shape.classId ||
        plan.intent.layoutKey !== preparedIrClassLayoutKey(contract.shape))
    )
      invalid(`ABI class ${plan.id} contradicts its declared class layout`);
  } else if (contract.kind === "support" && plan.intent.kind === "support" && contract.role !== plan.intent.role)
    invalid(`ABI support ${plan.id} contradicts its declared role`);
}

/** Reconcile the final semantic demand against the canonical catalog, including shared ownership. */
function validateRuntimeCallables(program: PreparedIrProgram): void {
  const collected = prepareIrProgramRuntimeCallables(program);
  if (collected.kind !== "prepared")
    invalid(
      `${collected.sourceFile}:${collected.location.line}:${collected.location.column} (${collected.unitId}): ${collected.detail}`,
    );
  const actual = program.abi.entries.filter(
    (entry) => entry.contract.kind === "callable" && entry.contract.ref.binding.kind === "runtime",
  );
  if (actual.length !== collected.declarations.length)
    invalid("runtime ABI declaration population differs from final semantic demand");
  if (actual.length === 0) return;
  const anchor = preparedIrRuntimeAbiAnchor(program.inventory);
  const runtimeEntries = new Set(actual);
  const firstOrder = program.abi.entries.filter(
    (entry) => !runtimeEntries.has(entry) && entry.plan.order.sourceOrder === anchor.order,
  ).length;
  for (const [index, declaration] of collected.declarations.entries()) {
    const key = irCallableBindingKey(declaration.ref.binding);
    const matches = actual.filter(
      (entry) => entry.contract.kind === "callable" && irCallableBindingKey(entry.contract.ref.binding) === key,
    );
    if (matches.length !== 1) invalid(`runtime ABI lacks one exact declaration for ${key}`);
    const expected: PreparedIrAbiEntry = {
      plan: {
        id: preparedIrRuntimeCallableBindingId(program.inventory, declaration.ref),
        order: { sourceOrder: anchor.order, declarationOrder: firstOrder + index },
        displayName: declaration.ref.name,
        structuralReferenceKey: key,
        slotPolicy: "required",
        slotSpace: "function",
        intent: {
          kind: "callable",
          origin: "runtime",
          signature: preparedIrCallableSignature(declaration.params, declaration.results),
        },
      },
      contract: { kind: "callable", ref: declaration.ref, params: declaration.params, results: declaration.results },
    };
    const mismatch = preparedIrDataMismatch(expected, matches[0]);
    if (mismatch !== undefined) invalid(`runtime ABI ${key} contradicts its canonical declaration at ${mismatch}`);
  }
}

/** Complete source-free validation precedes lookup reconstruction, backend acceptance and replay. */
export function assertPreparedIrProgram(program: PreparedIrProgram): void {
  if (program.schema !== "prepared-ir-program-v1" || program.reconciliation !== "complete" || program.sealed !== true)
    invalid("program is not a complete prepared program");
  assertPreparedIrProgramPopulation(program);
  assertPreparedIrSemanticRuntimeSeparation(program);
  assertPreparedIrProgramAllocations(program);
  assertPreparedIrClassLayouts(program);
  if (program.units.size !== program.inventory.terminalUnits.length)
    invalid("program unit receipt denominator differs from original inventory");
  for (const unit of program.inventory.terminalUnits) {
    const receipt = program.units.get(unit.id);
    if (
      !receipt ||
      receipt.id !== unit.id ||
      receipt.sourceId !== unit.sourceId ||
      receipt.kind !== unit.kind ||
      receipt.declarationStart !== unit.declarationStart ||
      receipt.declarationEnd !== unit.declarationEnd
    )
      invalid(`program receipt ${unit.id} contradicts the original inventory`);
  }
  const entries = new Map(program.abi.entries.map((entry) => [entry.plan.id, entry]));
  if (entries.size !== program.abi.entries.length) invalid("program ABI duplicates a binding");
  validateRuntimeCallables(program);
  const authority = new ProgramAbiMap(program.inventory, program.derivedUnits);
  for (const entry of program.abi.entries) {
    validateEntry(entry, entries);
    authority.plan(entry.plan);
  }
  authority.sealPlan();
  const functions = new Map(program.ir.functions.map((fn) => [fn.unitId, fn]));
  const calls = new Map<string, PreparedIrAbiEntry>();
  const globals = new Map<string, PreparedIrAbiEntry>();
  const declaredSignatures = new Map<string, IrDeclaredSignature>();
  const declaredGlobals = new Map<string, IrType>();
  for (const entry of program.abi.entries) {
    if (entry.plan.slotPolicy === "alias") continue;
    if (entry.contract.kind === "callable") {
      const key = irCallableBindingKey(entry.contract.ref.binding);
      if (calls.has(key)) invalid(`program ABI duplicates callable reference ${key}`);
      calls.set(key, entry);
      declaredSignatures.set(irBindingKey(entry.contract.ref.binding)!, {
        params: entry.contract.params,
        result: entry.contract.results[0] ?? null,
      });
    } else if (entry.contract.kind === "global") {
      const key = irGlobalBindingKey(entry.contract.ref.binding);
      if (globals.has(key)) invalid(`program ABI duplicates global reference ${key}`);
      globals.set(key, entry);
      declaredGlobals.set(irBindingKey(entry.contract.ref.binding)!, entry.contract.type);
    }
  }
  for (const fn of functions.values()) {
    const own = entries.get(irUnitCallableBindingId(fn.unitId));
    if (
      own?.contract.kind !== "callable" ||
      !sameSignature(
        preparedIrCallableSignature(own.contract.params, own.contract.results),
        preparedIrCallableSignature(
          fn.params.map((param) => param.type),
          fn.resultTypes,
        ),
      )
    )
      invalid(`body ${fn.unitId} lacks its exact declared ABI`);
    if (
      (fn.asyncPlan === undefined) !== (own.contract.promise === undefined) ||
      (fn.asyncPlan && preparedIrDataKey(fn.asyncPlan.abi) !== preparedIrDataKey(own.contract.promise))
    )
      invalid(`body ${fn.unitId} has a contradictory Promise contract`);
    const buffers = [
      ...fn.blocks.map((block) => block.instrs),
      ...(fn.asyncPlan?.states.map((state) => state.body) ?? []),
    ];
    for (const buffer of buffers)
      for (const root of buffer)
        forEachInstrDeep(root, (instruction) => {
          if (instruction.kind === "call" && !calls.has(irCallableBindingKey(instruction.target.binding)))
            invalid(
              `body ${fn.unitId} calls an undeclared callable ${irCallableBindingKey(instruction.target.binding)}`,
            );
          if (instruction.kind === "closure.new" && !calls.has(irCallableBindingKey(instruction.liftedFunc.binding)))
            invalid(`body ${fn.unitId} captures an undeclared callable`);
          if (
            (instruction.kind === "global.get" || instruction.kind === "global.set") &&
            !globals.has(irGlobalBindingKey(instruction.target.binding))
          )
            invalid(`body ${fn.unitId} references undeclared global ${instruction.target.binding.bindingId}`);
        });
    const errors = verifyIrFunction(fn, undefined, { declaredSignatures, declaredGlobals });
    if (errors.length) invalid(`body ${fn.unitId}: ${errors.map((error) => error.message).join("; ")}`);
  }
  if (program.startup.length !== program.inventory.sources.length) invalid("startup omits or duplicates a source");
  for (const [index, plan] of program.startup.entries()) {
    const source = program.inventory.sources[index]!;
    if (plan.sourceId !== source.id) invalid("startup contradicts canonical dependency order");
    const original = program.inventory.terminalUnits.filter(
      (unit) => unit.sourceId === source.id && unit.kind === "module-init",
    );
    if (plan.executable && (original.length !== 1 || plan.unitId !== original[0]!.id || !functions.has(plan.unitId)))
      invalid(`startup source ${source.id} lacks its one exact typed body`);
    if (!plan.executable && (plan.unitId !== null || original.length !== 0))
      invalid(`empty startup source ${source.id} claims an executable body`);
    if (plan.gaps.length) invalid(`startup source ${source.id} retains unresolved binding/export gaps`);
    for (const binding of plan.bindings)
      for (const id of [binding.globalBindingId, binding.tdzBindingId])
        if (id !== null && entries.get(id)?.contract.kind !== "global")
          invalid(`startup source ${source.id} lacks declared storage ${id}`);
  }
  if (program.runtime.length === 0) invalid("program lacks an explicit runtime projection");
  const projections = new Set<string>();
  for (const projection of program.runtime) {
    const key = `${projection.backend}:${projection.target}`;
    if (projections.has(key)) invalid(`program duplicates runtime projection ${key}`);
    projections.add(key);
    const runtime = projection.prepared;
    if (runtime.manifest.policy.backend !== projection.backend || runtime.manifest.policy.target !== projection.target)
      invalid(`runtime projection ${key} contradicts its frozen policy`);
    assertPreparedIrProgramPopulation({
      inventory: program.inventory,
      derivedUnits: program.derivedUnits,
      ir: { functions: runtime.functions },
    });
    assertPreparedIrRuntimeProjection(program, projection);
  }
}
