// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrInstr, IrType, IrValueId } from "../core/nodes.js";
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import { closureSignatureEquals } from "../core/types.js";
import type { NativeSourceClosureRequirements } from "./native-source-closure-requirements.js";

/** Only a real source parameter may introduce a runtime-supplied callable. */
export function nativeInvocationParameter(
  source: NativeSourceClosureRequirements,
  unitId: IrUnitId,
  callee: IrValueId,
  defs: ReadonlyMap<IrValueId, IrInstr>,
  types: ReadonlyMap<IrValueId, IrType>,
) {
  const erased = defs.get(callee);
  if (erased?.kind !== "coerce.to_externref") return undefined;
  const type = types.get(erased.value);
  if (type?.kind !== "callable") return undefined;
  const owner = source.demands.owners.find((row) => row.unitId === unitId);
  if (!owner?.projectedFunction.closureSubtype) return undefined;
  const index = owner.projectedFunction.params.findIndex((param) => param.value === erased.value);
  const original = owner.programFunction.params[index];
  if (
    index < 1 ||
    original?.type.kind !== "callable" ||
    !closureSignatureEquals(original.type.signature, type.signature)
  )
    return undefined;
  return { index, signature: type.signature };
}
