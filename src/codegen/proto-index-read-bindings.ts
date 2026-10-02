// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../ir/types.js";
import { buildProtoIndexRead, type ProtoIndexReadBinding } from "../runtime/wasmgc/values/object-get-arms.js";
import type { CodegenContext } from "./context/types.js";

const PROTOIDX_GET_R = "__protoidx_get_r";
const PROTOIDX_GET_K = "__protoidx_get_k";
const PROTOIDX_BRAND_OFF = "__protoidx_brand_off";
const PROTOIDX_HAS_R = "__protoidx_has_r";

/**
 * (#4176) Receiver-aware GET consult `[recv, key] -> externref` for a
 * non-`$Object` miss chokepoint (`__closure_prop_get` / `__vec_prop_get`
 * tails): classifies the receiver's proto brand at runtime and consults that
 * companion, then Object's. `undefined` when unreserved — the caller keeps
 * its pre-existing miss byte-identically.
 */
export function protoIndexRecvGetMissInstrs(
  ctx: CodegenContext,
  recvLocal: number,
  keyLocal: number,
  accessorRecvLocal?: number,
): Instr[] | undefined {
  return buildProtoIndexRead(captureProtoIndexReadBinding(ctx, recvLocal, keyLocal, accessorRecvLocal));
}

export function captureProtoIndexReadBinding(
  ctx: CodegenContext,
  recvLocal: number,
  keyLocal: number,
  accessorRecvLocal?: number,
): ProtoIndexReadBinding | undefined {
  const getRIdx = ctx.funcMap.get(PROTOIDX_GET_R);
  if (getRIdx === undefined) return undefined;
  const getKIdx = ctx.funcMap.get(PROTOIDX_GET_K);
  const brandOffIdx = ctx.funcMap.get(PROTOIDX_BRAND_OFF);
  if (
    accessorRecvLocal !== undefined &&
    accessorRecvLocal !== recvLocal &&
    getKIdx !== undefined &&
    brandOffIdx !== undefined
  ) {
    return {
      kind: "split-receiver",
      receiver: recvLocal,
      key: keyLocal,
      accessorReceiver: accessorRecvLocal,
      brandOffset: brandOffIdx,
      getKey: getKIdx,
    };
  }
  return { kind: "direct", receiver: recvLocal, key: keyLocal, get: getRIdx };
}

/** (#4176) Receiver-aware HAS consult `[recv, key] -> i32`; see get twin. */
export function protoIndexRecvHasMissInstrs(
  ctx: CodegenContext,
  recvLocal: number,
  keyLocal: number,
): Instr[] | undefined {
  const hasRIdx = ctx.funcMap.get(PROTOIDX_HAS_R);
  if (hasRIdx === undefined) return undefined;
  return [
    { op: "local.get", index: recvLocal },
    { op: "local.get", index: keyLocal },
    { op: "call", funcIdx: hasRIdx },
  ];
}
