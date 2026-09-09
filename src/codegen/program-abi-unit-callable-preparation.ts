// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { CodegenContext } from "./context/types.js";
import type { IrUnitId } from "../ir/identity.js";
import { ProgramAbiInvariantError } from "../ir/program-abi.js";
import type { ProgramAbiSession } from "./program-abi-session.js";
import { describeProgramAbiUnitCallable, type ProgramAbiUnitCallablePlan } from "./program-abi-planning.js";
import type {
  PreparedProgramAbiDescriptorLifecycle,
  PreparedProgramAbiDescriptorPart,
} from "./program-abi-prepared-transaction.js";
import {
  canonicalProgramAbiCallableTypeContract,
  programAbiCallableSignaturesEqual,
} from "./program-abi-signatures.js";

export interface PreparedUnitCallableDescriptor {
  readonly kind: "prepared-unit-callables";
}
interface Payload {
  readonly ctx: CodegenContext;
  readonly session: ProgramAbiSession;
  readonly terminalUnitIds: readonly IrUnitId[];
  readonly plans: readonly ProgramAbiUnitCallablePlan[];
  readonly lifecycle: PreparedProgramAbiDescriptorLifecycle;
}
const payloads = new WeakMap<PreparedUnitCallableDescriptor, Payload>();
function fail(message: string): never {
  throw new ProgramAbiInvariantError("invalid-callable-provenance", message);
}

function bindings(payload: Payload) {
  const { ctx, session, plans, terminalUnitIds } = payload;
  if (ctx.programAbiSession !== session) fail("prepared unit callables crossed sessions");
  const owners = new Set(terminalUnitIds);
  const ids = new Set<IrUnitId>();
  return plans.map((plan) => {
    if (plan.ref.binding.kind !== "unit") fail("prepared callable is not an exact unit");
    const id = plan.ref.binding.unitId;
    const unit = session.inventory.allUnits.find((unit) => unit.id === id) ?? session.registeredDerivedUnit(id);
    if (!unit || unit.terminalOwnerId === null || !owners.has(unit.terminalOwnerId) || ids.has(id)) {
      fail("prepared callable has a foreign or duplicate terminal owner");
    }
    ids.add(id);
    const expectedAllocator =
      ctx.irUnitFuncMap.get(id) ??
      ctx.programAbiSourceCallables?.functionForUnit(id) ??
      ctx.programAbiClassCallables?.functionForUnit(id) ??
      ctx.programAbiModuleInitCallables?.functionForUnit(id);
    if (expectedAllocator !== plan.func) fail("prepared callable does not own its exact unit allocator");
    const signature = ctx.mod.types[plan.func.typeIdx];
    if (
      !ctx.mod.functions.includes(plan.func) ||
      signature?.kind !== "func" ||
      !programAbiCallableSignaturesEqual(
        canonicalProgramAbiCallableTypeContract(signature),
        canonicalProgramAbiCallableTypeContract(plan.signature),
      )
    ) {
      fail("prepared callable lost its exact allocator or signature");
    }
    const contribution = describeProgramAbiUnitCallable(ctx, plan);
    if (!contribution) fail("prepared callable has no structural contribution");
    return contribution;
  });
}

/** Authenticate a non-publishing contribution for one exact terminal population. */
export function describePreparedUnitCallables(
  ctx: CodegenContext,
  terminalUnitIds: readonly IrUnitId[],
  plans: readonly ProgramAbiUnitCallablePlan[],
): PreparedUnitCallableDescriptor {
  const session = ctx.programAbiSession;
  if (
    !session ||
    terminalUnitIds.length === 0 ||
    new Set(terminalUnitIds).size !== terminalUnitIds.length ||
    plans.length === 0
  ) {
    fail("prepared unit callables require a session and nonempty exact population");
  }
  const payload: Payload = {
    ctx,
    session,
    terminalUnitIds: Object.freeze([...terminalUnitIds]),
    plans: Object.freeze(
      plans.map((plan) => ({
        ...plan,
        signature: {
          kind: "func" as const,
          params: plan.signature.params.map((value) => ({ ...value })),
          results: plan.signature.results.map((value) => ({ ...value })),
        },
      })),
    ),
    lifecycle: { state: new Map([["state", "fresh"]]) },
  };
  bindings(payload);
  const descriptor = Object.freeze({ kind: "prepared-unit-callables" as const });
  payloads.set(descriptor, payload);
  return descriptor;
}

export function prepareUnitCallableDescriptorForScope(
  descriptor: PreparedUnitCallableDescriptor,
  session: ProgramAbiSession,
  scopeId: string,
  terminalUnitIds: readonly IrUnitId[],
): PreparedProgramAbiDescriptorPart {
  const payload = payloads.get(descriptor);
  if (
    !payload ||
    payload.session !== session ||
    scopeId.length === 0 ||
    payload.terminalUnitIds.length !== terminalUnitIds.length ||
    payload.terminalUnitIds.some((id) => !terminalUnitIds.includes(id))
  )
    fail("foreign prepared unit callable scope");
  if (payload.lifecycle.state.get("state") !== "fresh") fail("prepared unit callable descriptor already claimed");
  payload.lifecycle.state.set("state", "claimed");
  payload.lifecycle.state.set("scopeId", scopeId);
  try {
    const provisional = bindings(payload);
    return {
      kind: "unit-callables",
      session,
      descriptor,
      lifecycle: payload.lifecycle,
      bindings: provisional,
      requestedStructuralReferenceKeys: [],
      closureStructuralReferenceKeys: [],
      registryWrites: [],
      exclusiveBindingIds: provisional.map((binding) => binding.draft.id),
      rebaseBindings: () => bindings(payload),
      assertCurrent: () => {
        if (payload.lifecycle.state.get("state") !== "claimed" || payload.lifecycle.state.get("scopeId") !== scopeId) {
          fail("prepared unit callable descriptor lost its scope claim");
        }
        bindings(payload);
      },
    };
  } catch (error) {
    payload.lifecycle.state.set("state", "consumed");
    throw error;
  }
}

export function consumePreparedUnitCallableDescriptor(
  descriptor: PreparedUnitCallableDescriptor,
  session: ProgramAbiSession,
  scopeId: string,
): void {
  const payload = payloads.get(descriptor);
  if (
    !payload ||
    payload.session !== session ||
    payload.lifecycle.state.get("state") !== "claimed" ||
    payload.lifecycle.state.get("scopeId") !== scopeId
  )
    fail("invalid prepared unit callable consumption");
  payload.lifecycle.state.set("state", "consumed");
}
