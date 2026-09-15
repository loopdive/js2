// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../ir/types.js";
import { buildTargetTaggedTry } from "../ir/try-table.js";
import type { CodegenContext, FunctionContext, NativeGeneratorInfo } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { ERROR_FIELD, MODE_THROW } from "./frame-core.js";
import { emitThrowTypeError } from "./js-errors.js";
import { ensureExnTag } from "./registry/imports.js";

/** Array iterators have no throw method: replace the error before outer unwind. */
export function emitVecDelegationAbrupt(
  ctx: CodegenContext,
  fctx: FunctionContext,
  info: NativeGeneratorInfo,
  siteIndex: number,
  selfLocal: number,
): void {
  const slot = info.vecDelegationSlots?.[siteIndex];
  if (!slot || slot.vecTypeIdx === null) throw new Error("Missing vector delegation slot");
  const saved = fctx.body;
  const throwBody: Instr[] = [];
  fctx.body = throwBody;
  emitThrowTypeError(ctx, fctx, "The delegated iterator has no throw method");
  fctx.body = saved;
  const error = allocLocal(fctx, `__vec_delegate_error_${fctx.locals.length}`, { kind: "externref" });
  saved.push(
    { op: "local.get", index: selfLocal },
    { op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: slot.vecFieldIdx },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    { op: "local.get", index: selfLocal },
    { op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: info.modeFieldIdx },
    { op: "i32.const", value: MODE_THROW },
    { op: "i32.eq" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        buildTargetTaggedTry(ctx, { kind: "empty" }, throwBody, [
          {
            tagIdx: ensureExnTag(ctx),
            body: [
              { op: "local.set", index: error },
              { op: "local.get", index: selfLocal },
              { op: "local.get", index: error },
              { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: ERROR_FIELD },
            ],
          },
        ]),
      ],
      else: [],
    },
    { op: "local.get", index: selfLocal },
    { op: "ref.null", typeIdx: slot.vecTypeIdx },
    { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: slot.vecFieldIdx },
  );
}
