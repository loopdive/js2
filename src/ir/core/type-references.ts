// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { requireBindingId, requireNonEmpty } from "./binding-key-primitives.js";
import { createIrBindingId } from "../../shared/contracts/identity-values.js";
import type { IrClassId, IrSourceId, IrUnitId } from "../../shared/contracts/ir-identity.js";
import type { IrTypeBinding, IrTypeRef } from "./types.js";

type IrBindingOwnerId = IrSourceId | IrUnitId | IrClassId;

export function typeRef(name: string, binding: IrTypeBinding): IrTypeRef {
  requireBindingId(binding.bindingId, "type bindingId", binding.kind === "class" ? "class" : "type");
  return Object.freeze({
    kind: "type",
    name: requireNonEmpty(name, "type compatibility name"),
    binding: Object.freeze(binding),
  });
}

/** Reference one compiler support type intention. */
export function irSupportTypeRef(
  ownerId: IrBindingOwnerId,
  role: string,
  adapterName: string,
  ordinal?: number,
): IrTypeRef {
  const checkedRole = requireNonEmpty(role, "support type role");
  return typeRef(adapterName, {
    kind: "support",
    bindingId: createIrBindingId({
      ownerId: requireNonEmpty(ownerId, "support type owner identity") as IrBindingOwnerId,
      domain: "type",
      role: checkedRole,
      ordinal,
    }),
  });
}
