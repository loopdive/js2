// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Stage 3 of the Prepared validator (#7380): the invariants of a physical setup plan that no single planner step
// establishes, read as plain data. Slots come from several producers (bodies, ABI imports, host-number and async
// imports, number remainders, the vector helper, native bindings) and resource declarations from two setups, so
// "no binding and no resource key has two slots" and "every type key a declaration names is declared" hold only
// across them. What the planner checks itself (references, exports, startup) it refuses by name as a gap; that is
// admission and is not repeated here. A violation is a compiler bug.

import type { IrBindingId } from "../shared/contracts/ir-identity.js";
import type { PhysicalSetupPlan } from "./program-physical-plan.js";
import { PreparedIrProgramInvariantError } from "./program/errors.js";

function invalid(invariant: string, detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", `physical plan: ${invariant}: ${detail}`);
}

function assertUniqueSlots(plan: PhysicalSetupPlan): void {
  const slots: IrBindingId[] = [
    ...plan.functions.map((slot) => slot.bindingId),
    ...plan.importedFunctions.map((row) => row.bindingId),
    ...plan.importedGlobals.map((row) => row.bindingId),
    ...plan.definedGlobals.map((row) => row.bindingId),
    ...plan.numberRemainders.map((row) => row.bindingId),
    ...(plan.vectors.helper ? [plan.vectors.helper.bindingId] : []),
    ...[
      ...(plan.nativeStrings?.bindings ?? []),
      ...(plan.nativeNumberFormat?.bindings ?? []),
      ...(plan.nativeInvocation?.bindings ?? []),
    ].map((row) => row.entry.id),
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

/** Stage 3 entry. */
export function assertPhysicalSetupPlan(plan: PhysicalSetupPlan): void {
  assertUniqueSlots(plan);
  assertResourceDeclarations(plan);
}
