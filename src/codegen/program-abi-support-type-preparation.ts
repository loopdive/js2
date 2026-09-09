// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrBindingId, IrUnitId } from "../ir/identity.js";
import { ProgramAbiInvariantError } from "../ir/program-abi.js";
import type { CodegenContext } from "./context/types.js";
import type { ProgramAbiSession } from "./program-abi-session.js";
import type {
  PreparedProgramAbiDescriptorLifecycle,
  PreparedProgramAbiDescriptorPart,
} from "./program-abi-prepared-transaction.js";
import { canonicalProgramAbiTypeDef } from "./program-abi-signatures.js";

export interface PreparedSupportTypeDescriptor {
  readonly kind: "prepared-support-types";
}
interface Payload {
  readonly ctx: CodegenContext;
  readonly session: ProgramAbiSession;
  readonly ids: readonly IrBindingId[];
  readonly terminals: readonly IrUnitId[];
  readonly lifecycle: PreparedProgramAbiDescriptorLifecycle;
}
const payloads = new WeakMap<PreparedSupportTypeDescriptor, Payload>();
function fail(message: string): never {
  throw new ProgramAbiInvariantError("type-remap-mismatch", message);
}
function bindings(payload: Payload) {
  const { ctx, session } = payload;
  if (ctx.programAbiSession !== session || !ctx.programAbiTypes) fail("support types crossed their session");
  const candidates = new Map(
    ctx.programAbiTypes.provisionalSupportTypes().map((binding) => [binding.draft.id, binding]),
  );
  return payload.ids.map((id) => {
    const binding = candidates.get(id);
    if (!binding || binding.locator?.kind !== "type-cell" || binding.draft.intent.kind !== "type") {
      fail("prepared support type has no authenticated candidate");
    }
    const cell = binding.locator.cell;
    const type = cell.current;
    if (
      !type ||
      !ctx.mod.types.includes(type) ||
      session.typeCellFor(type) !== cell ||
      canonicalProgramAbiTypeDef(type) !== binding.draft.intent.shapeKey
    ) {
      fail("prepared support type lost its exact allocator or shape");
    }
    return binding;
  });
}

export function describePreparedSupportTypes(
  ctx: CodegenContext,
  terminals: readonly IrUnitId[],
  ids: readonly IrBindingId[],
): PreparedSupportTypeDescriptor {
  if (
    !ctx.programAbiSession ||
    ids.length === 0 ||
    terminals.length === 0 ||
    new Set(ids).size !== ids.length ||
    new Set(terminals).size !== terminals.length
  )
    fail("invalid support type population");
  const payload: Payload = {
    ctx,
    session: ctx.programAbiSession,
    ids: Object.freeze([...ids]),
    terminals: Object.freeze([...terminals]),
    lifecycle: { state: new Map([["state", "fresh"]]) },
  };
  bindings(payload);
  const token = Object.freeze({ kind: "prepared-support-types" as const });
  payloads.set(token, payload);
  return token;
}

export function prepareSupportTypeDescriptorForScope(
  descriptor: PreparedSupportTypeDescriptor,
  session: ProgramAbiSession,
  scopeId: string,
  terminals: readonly IrUnitId[],
): PreparedProgramAbiDescriptorPart {
  const payload = payloads.get(descriptor);
  if (
    !payload ||
    payload.session !== session ||
    !scopeId ||
    payload.terminals.length !== terminals.length ||
    payload.terminals.some((id) => !terminals.includes(id))
  )
    fail("foreign support type scope");
  if (payload.lifecycle.state.get("state") !== "fresh") fail("support type descriptor already claimed");
  payload.lifecycle.state.set("state", "claimed");
  payload.lifecycle.state.set("scopeId", scopeId);
  try {
    return {
      kind: "support-types",
      session,
      descriptor,
      lifecycle: payload.lifecycle,
      bindings: bindings(payload),
      requestedStructuralReferenceKeys: [],
      closureStructuralReferenceKeys: [],
      registryWrites: [],
      rebaseBindings: () => bindings(payload),
      assertCurrent: () => {
        if (payload.lifecycle.state.get("state") !== "claimed" || payload.lifecycle.state.get("scopeId") !== scopeId) {
          fail("support type descriptor lost its scope claim");
        }
        bindings(payload);
      },
    };
  } catch (error) {
    payload.lifecycle.state.set("state", "consumed");
    throw error;
  }
}

export function consumePreparedSupportTypeDescriptor(
  descriptor: PreparedSupportTypeDescriptor,
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
    fail("invalid support type descriptor consumption");
  payload.lifecycle.state.set("state", "consumed");
}
