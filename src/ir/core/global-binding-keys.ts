// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrGlobalBinding } from "./value-references.js";
import { requireBindingId, requireNonEmpty, keyPart, irSourceGlobalBindingKey } from "./binding-key-primitives.js";

export function requireString(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  return value;
}

/** Canonical global-binding key. Compatibility names are deliberately excluded. */
export function irGlobalBindingKey(binding: IrGlobalBinding): string {
  const bindingId = keyPart(requireBindingId(binding.bindingId, "global bindingId", "global"));
  switch (binding.kind) {
    case "source":
      return irSourceGlobalBindingKey(binding.bindingId, binding.capability);
    case "support":
      return `${binding.kind}|${bindingId}`;
    case "import":
      return (
        `import|${bindingId}|${keyPart(requireNonEmpty(binding.module, "global import module"))}|` +
        keyPart(requireString(binding.field, "global import field"))
      );
    case "runtime":
      return `runtime|${bindingId}|${keyPart(requireNonEmpty(binding.symbol, "runtime global symbol"))}`;
    default: {
      const exhaustive: never = binding;
      throw new TypeError(`unknown global binding kind ${(exhaustive as { kind?: unknown }).kind ?? "<missing>"}`);
    }
  }
}

export function sameIrGlobalBinding(left: IrGlobalBinding, right: IrGlobalBinding): boolean {
  return irGlobalBindingKey(left) === irGlobalBindingKey(right);
}
