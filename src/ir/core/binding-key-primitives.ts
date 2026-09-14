// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrBindingId } from "../../shared/contracts/ir-identity.js";

export function requireNonEmpty(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

export function requireBindingId(value: IrBindingId, label: string, domain: "global" | "type" | "class"): IrBindingId {
  const checked = requireNonEmpty(value, label);
  if (!checked.startsWith(`ir-binding:v1:${domain}:`)) {
    throw new TypeError(`${label} must belong to the ${domain} binding domain`);
  }
  return checked as IrBindingId;
}

export function requireSourceGlobalCapability(value: "dom" | undefined): "dom" | undefined {
  if (value !== undefined && value !== "dom") {
    throw new TypeError("source global capability must be dom when present");
  }
  return value;
}

export function keyPart(value: string): string {
  return `${value.length}:${value}`;
}

/** Canonical source-global key; compatibility labels do not participate. */
export function irSourceGlobalBindingKey(bindingId: IrBindingId, capability?: "dom"): string {
  const id = keyPart(requireBindingId(bindingId, "global bindingId", "global"));
  const checkedCapability = requireSourceGlobalCapability(capability);
  return checkedCapability === undefined ? `source|${id}` : `source|${id}|capability|${keyPart(checkedCapability)}`;
}
