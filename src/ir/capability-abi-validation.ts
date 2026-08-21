// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrBindingId } from "./identity.js";
import type { IrCallableBinding } from "./nodes.js";
import type { ProgramAbiIntent } from "./program-abi.js";

interface RequiredBindingEntry {
  readonly requested: { readonly id: IrBindingId; readonly slotPolicy: string };
  readonly canonical: { readonly id: IrBindingId; readonly slotPolicy: string };
}

export function capabilityGlobalIntentMatches(
  intent: ProgramAbiIntent,
  expectedOrigin: "source" | "import" | "runtime" | "support",
  expectedCapability: "dom" | undefined,
): boolean {
  return (
    intent.kind === "global" &&
    intent.capability === expectedCapability &&
    (expectedOrigin === "source" || expectedOrigin === "support" ? intent.origin === expectedOrigin : true)
  );
}

export function hasExactRequiredCapabilityGlobal(entry: RequiredBindingEntry, bindingId: IrBindingId): boolean {
  return (
    entry.requested.id === bindingId &&
    entry.canonical.id === bindingId &&
    entry.requested.slotPolicy === "required" &&
    entry.canonical.slotPolicy === "required"
  );
}

export function externalCallableIntentMatches(intent: ProgramAbiIntent, binding: IrCallableBinding): boolean {
  return (
    intent.kind === "callable" &&
    intent.origin !== "source" &&
    (binding.kind !== "import" ||
      (intent.capabilityId === binding.capabilityId && intent.providerId === binding.providerId))
  );
}
