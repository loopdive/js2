// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { keyPart, requireBindingId, requireNonEmpty } from "./binding-key-primitives.js";
import type { IrTypeBinding } from "./types.js";

/** Canonical type-binding key. Compatibility names are deliberately excluded. */
export function irTypeBindingKey(binding: IrTypeBinding): string {
  const bindingId = keyPart(
    requireBindingId(binding.bindingId, "type bindingId", binding.kind === "class" ? "class" : "type"),
  );
  switch (binding.kind) {
    case "source":
    case "support":
      return `${binding.kind}|${bindingId}`;
    case "class":
      return `class|${bindingId}|${keyPart(requireNonEmpty(binding.classId, "class type identity"))}`;
    case "runtime":
      return `runtime|${bindingId}|${keyPart(requireNonEmpty(binding.symbol, "runtime type symbol"))}`;
    default: {
      const exhaustive: never = binding;
      throw new TypeError(`unknown type binding kind ${(exhaustive as { kind?: unknown }).kind ?? "<missing>"}`);
    }
  }
}
