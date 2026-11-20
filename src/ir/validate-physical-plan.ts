// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Stage 3 of the Prepared validator (#7380): the invariants of a physical setup plan, read as plain data. The plan
// belongs to the requested backend and target; no binding and no resource key has two slots; every type key a
// resource declaration names is declared; every function, global and provider a physical body names has a slot;
// every export and startup unit resolves to one. The planner refuses a program by
// name before it builds a plan that would break these, so a violation here is a compiler bug.

import { irCallableBindingKey } from "./core/callable-bindings.js";
import { irGlobalBindingKey } from "./core/global-binding-keys.js";
import { forEachPreparedIrInstruction } from "./runtime/prepared-instructions.js";
import type { IrBindingId } from "../shared/contracts/ir-identity.js";
import type { NativeStringValueAbiBinding, PhysicalSetupPlan } from "./program-physical-plan.js";
import type { PreparedIrBackendOptions } from "./program.js";
import { PreparedIrProgramInvariantError } from "./program/errors.js";
import type { PreparedIrProgram, PreparedIrProgramRuntimeProjection } from "./program/prepared-contracts.js";

type ReservedRows = Pick<
  PhysicalSetupPlan,
  "functions" | "importedFunctions" | "importedGlobals" | "definedGlobals" | "numberRemainders" | "vectors"
>;

function invalid(invariant: string, detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", `physical plan: ${invariant}: ${detail}`);
}

function nativeBindings(plan: PhysicalSetupPlan): readonly NativeStringValueAbiBinding[] {
  return [
    ...(plan.nativeStrings?.bindings ?? []),
    ...(plan.nativeNumberFormat?.bindings ?? []),
    ...(plan.nativeInvocation?.bindings ?? []),
  ];
}

/** The callable and global reference keys a plan reserves a slot for. The planner and this validator share it. */
export function physicalPlanReferenceKeys(
  rows: ReservedRows,
  native: readonly NativeStringValueAbiBinding[],
): { readonly callables: ReadonlySet<string>; readonly globals: ReadonlySet<string> } {
  const callables = new Set<string>([
    ...rows.functions.map((slot) => irCallableBindingKey({ kind: "unit", unitId: slot.unitId })),
    ...rows.importedFunctions.map((fn) => fn.referenceKey),
    ...(rows.vectors.helper ? [rows.vectors.helper.referenceKey] : []),
    ...rows.numberRemainders.map((resource) => resource.referenceKey),
  ]);
  const globals = new Set<string>([...rows.importedGlobals, ...rows.definedGlobals].map((row) => row.referenceKey));
  for (const { reference } of native) {
    if (reference.kind === "func") callables.add(irCallableBindingKey(reference.binding));
    else if (reference.kind === "global") globals.add(irGlobalBindingKey(reference.binding));
  }
  return { callables, globals };
}

function assertUniqueSlots(plan: PhysicalSetupPlan): void {
  const slots: IrBindingId[] = [
    ...plan.functions.map((slot) => slot.bindingId),
    ...plan.importedFunctions.map((row) => row.bindingId),
    ...plan.importedGlobals.map((row) => row.bindingId),
    ...plan.definedGlobals.map((row) => row.bindingId),
    ...plan.numberRemainders.map((row) => row.bindingId),
    ...(plan.vectors.helper ? [plan.vectors.helper.bindingId] : []),
    ...nativeBindings(plan).map((row) => row.entry.id),
  ];
  const seen = new Set<IrBindingId>();
  for (const id of slots) {
    if (seen.has(id)) invalid("duplicate slot", `binding ${id} has two slots`);
    seen.add(id);
  }
}

/** Every `typeKey` a resource declaration names, wherever in its shape, field, signature or name it sits. */
function collectTypeKeys(value: unknown, out: string[]): void {
  if (value === null || typeof value !== "object") return;
  for (const [key, field] of Object.entries(value)) {
    if (key === "typeKey" && typeof field === "string") out.push(field);
    else collectTypeKeys(field, out);
  }
}

function assertResourceDeclarations(plan: PhysicalSetupPlan): void {
  const declarations = [
    ...(plan.nativeStrings?.resources.declarations ?? []),
    ...(plan.nativeNumberFormat?.resources.declarations ?? []),
  ];
  const keys = new Set<string>();
  for (const { key } of declarations) {
    if (keys.has(key)) invalid("duplicate slot", `resource key ${key} is declared twice`);
    keys.add(key);
  }
  const types = new Set(declarations.filter((row) => row.space === "type").map((row) => row.key));
  for (const declaration of declarations) {
    const named: string[] = [];
    collectTypeKeys(declaration, named);
    for (const typeKey of named)
      if (!types.has(typeKey)) invalid("unresolved type key", `${declaration.key} names undeclared type ${typeKey}`);
  }
}

function assertReferencesResolve(plan: PhysicalSetupPlan, projection: PreparedIrProgramRuntimeProjection): void {
  const { callables, globals } = physicalPlanReferenceKeys(plan, nativeBindings(plan));
  for (const fn of projection.prepared.functions)
    forEachPreparedIrInstruction(fn, (instruction) => {
      if (instruction.kind === "call" || instruction.kind === "closure.new") {
        const ref = instruction.kind === "call" ? instruction.target : instruction.liftedFunc;
        if (!callables.has(irCallableBindingKey(ref.binding)))
          invalid("unresolved reference", `body ${fn.name} calls ${ref.name}, which has no slot`);
      } else if (instruction.kind === "global.get" || instruction.kind === "global.set") {
        if (!globals.has(irGlobalBindingKey(instruction.target.binding)))
          invalid("unresolved reference", `body ${fn.name} names global ${instruction.target.name}, which has no slot`);
      } else if (instruction.kind === "intrinsic" && instruction.provider?.kind === "callable") {
        if (!callables.has(irCallableBindingKey(instruction.provider.target.binding)))
          invalid("missing provider", `body ${fn.name} intrinsic ${instruction.id} has no provider slot`);
      }
    });
}

function assertExportsAndStartup(plan: PhysicalSetupPlan): void {
  const functions = new Set<IrBindingId>([
    ...plan.functions.map((slot) => slot.bindingId),
    ...plan.importedFunctions.map((row) => row.bindingId),
  ]);
  const globals = new Set<IrBindingId>([...plan.importedGlobals, ...plan.definedGlobals].map((row) => row.bindingId));
  const names = new Set<string>();
  for (const exported of plan.exports) {
    if (names.has(exported.externalName)) invalid("duplicate export", exported.externalName);
    names.add(exported.externalName);
    if (!(exported.space === "function" ? functions : globals).has(exported.targetBindingId))
      invalid("unresolved export", `${exported.externalName} targets ${exported.targetBindingId}, which has no slot`);
  }
  const units = new Set(plan.functions.map((slot) => slot.unitId));
  for (const unitId of plan.startup.units)
    if (!units.has(unitId)) invalid("unresolved startup", `startup unit ${unitId} has no function slot`);
}

/** Stage 3 entry: the plan of the projection the request selects. */
export function assertPhysicalSetupPlan(
  program: PreparedIrProgram,
  plan: PhysicalSetupPlan,
  options: Pick<PreparedIrBackendOptions, "backend" | "target">,
): void {
  const projection = program.runtime.find(
    (row) => row.backend === options.backend && row.target === options.target && row.backend === plan.backend,
  );
  if (!projection || plan.target !== options.target)
    invalid("request", `plan is for ${plan.backend}:${plan.target}, not ${options.backend}:${options.target}`);
  assertUniqueSlots(plan);
  assertResourceDeclarations(plan);
  assertReferencesResolve(plan, projection);
  assertExportsAndStartup(plan);
}
