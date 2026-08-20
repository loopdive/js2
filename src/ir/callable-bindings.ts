// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import {
  createIrBindingId,
  type IrBindingId,
  type IrClassId,
  type IrFunctionIdentity,
  type IrSourceId,
  type IrUnitId,
} from "./identity.js";
import type { IrCallableBinding, IrFuncRef } from "./nodes.js";

type IrCallableBindingOwnerId = IrSourceId | IrUnitId | IrClassId;

function requireNonEmpty(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function compatibilityName(explicit: string | undefined, fallback: string, label: string): string {
  return requireNonEmpty(explicit ?? fallback, label);
}

function funcRef(name: string, binding: IrCallableBinding): IrFuncRef {
  return Object.freeze({ kind: "func", name, binding: Object.freeze(binding) });
}

/** Canonical program-ABI identity for one exact unit's executable body. */
export function irUnitCallableBindingId(unitId: IrUnitId): IrBindingId {
  return createIrBindingId({
    ownerId: requireNonEmpty(unitId, "callable unitId") as IrUnitId,
    domain: "callable",
    role: "body",
  });
}

/** Reference one exact source or compiler-created function artifact. */
export function irUnitFuncRef(identity: IrFunctionIdentity): IrFuncRef {
  if (typeof identity !== "object" || identity === null) {
    throw new TypeError("function identity must be an object");
  }
  const unitId = requireNonEmpty(identity.unitId, "function unitId") as IrUnitId;
  const name = requireNonEmpty(identity.name, "function compatibility name");
  return funcRef(name, { kind: "unit", unitId });
}

/** Reference one declared module import. */
export function irImportFuncRef(module: string, field: string, adapterName?: string): IrFuncRef {
  const checkedModule = requireNonEmpty(module, "import module");
  const checkedField = requireNonEmpty(field, "import field");
  const name = compatibilityName(adapterName, checkedField, "import compatibility name");
  return funcRef(name, { kind: "import", module: checkedModule, field: checkedField });
}

/** Reference one compiler-certified platform-capability import. */
export function irCapabilityImportFuncRef(
  module: string,
  field: string,
  capabilityId: string,
  providerId: string,
  adapterName?: string,
): IrFuncRef {
  const checkedModule = requireNonEmpty(module, "capability import module");
  const checkedField = requireNonEmpty(field, "capability import field");
  const checkedCapability = requireNonEmpty(capabilityId, "capability import capability");
  const checkedProvider = requireNonEmpty(providerId, "capability import provider");
  const name = compatibilityName(adapterName, checkedField, "capability import compatibility name");
  return funcRef(name, {
    kind: "import",
    module: checkedModule,
    field: checkedField,
    capabilityId: checkedCapability,
    providerId: checkedProvider,
  });
}

/** Reference a compiler runtime symbol supplied by the selected runtime. */
export function irRuntimeFuncRef(symbol: string, adapterName?: string): IrFuncRef {
  const checkedSymbol = requireNonEmpty(symbol, "runtime symbol");
  const name = compatibilityName(adapterName, checkedSymbol, "runtime compatibility name");
  return funcRef(name, { kind: "runtime", symbol: checkedSymbol });
}

/** Reference a semantic intrinsic whose provider is selected below the IR. */
export function irIntrinsicFuncRef(symbol: string, adapterName?: string): IrFuncRef {
  const checkedSymbol = requireNonEmpty(symbol, "intrinsic symbol");
  const name = compatibilityName(adapterName, checkedSymbol, "intrinsic compatibility name");
  return funcRef(name, { kind: "intrinsic", symbol: checkedSymbol });
}

/** Reference a compiler-owned support callable derived from a structural owner. */
export function irSupportFuncRef(
  ownerId: IrCallableBindingOwnerId,
  role: string,
  adapterName: string,
  ordinal?: number,
): IrFuncRef {
  const checkedOwnerId = requireNonEmpty(ownerId, "support owner identity") as IrCallableBindingOwnerId;
  const checkedRole = requireNonEmpty(role, "support role");
  const name = requireNonEmpty(adapterName, "support compatibility name");
  return funcRef(name, {
    kind: "support",
    bindingId: createIrBindingId({ ownerId: checkedOwnerId, domain: "support", role: checkedRole, ordinal }),
  });
}

function keyPart(value: string): string {
  return `${value.length}:${value}`;
}

/** Canonical, injective key for a callable binding. Compatibility names are excluded. */
export function irCallableBindingKey(binding: IrCallableBinding): string {
  switch (binding.kind) {
    case "unit":
      return `unit|${keyPart(requireNonEmpty(binding.unitId, "callable unitId"))}`;
    case "import":
      if ((binding.capabilityId === undefined) !== (binding.providerId === undefined)) {
        throw new TypeError("callable import capability and provider provenance must be paired");
      }
      return (
        `import|${keyPart(requireNonEmpty(binding.module, "callable import module"))}|` +
        keyPart(requireNonEmpty(binding.field, "callable import field")) +
        (binding.capabilityId === undefined && binding.providerId === undefined
          ? ""
          : `|capability|${keyPart(requireNonEmpty(binding.capabilityId!, "callable import capability"))}|` +
            keyPart(requireNonEmpty(binding.providerId!, "callable import provider")))
      );
    case "runtime":
      return `runtime|${keyPart(requireNonEmpty(binding.symbol, "callable runtime symbol"))}`;
    case "intrinsic":
      return `intrinsic|${keyPart(requireNonEmpty(binding.symbol, "callable intrinsic symbol"))}`;
    case "support":
      return `support|${keyPart(requireNonEmpty(binding.bindingId, "callable support bindingId"))}`;
    default: {
      const exhaustive: never = binding;
      throw new TypeError(`unknown callable binding kind ${(exhaustive as { kind?: unknown }).kind ?? "<missing>"}`);
    }
  }
}

export function sameIrCallableBinding(left: IrCallableBinding, right: IrCallableBinding): boolean {
  return irCallableBindingKey(left) === irCallableBindingKey(right);
}
