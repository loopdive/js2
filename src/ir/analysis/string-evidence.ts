// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { asVal, type IrType } from "../nodes.js";
import { IR_STRING_RUNTIME, type IrStringRuntimeIntrinsic } from "../string-runtime.js";
import { joinEncoding, type Encoding } from "./encoding.js";

export type StringSemanticEvidenceSource = "checker" | "producer";

/**
 * Evidence is deliberately split into the JavaScript semantic type and the
 * IR carrier. Linear strings currently travel in i32 slots, so the carrier
 * alone must never decide whether string operations are legal.
 */
export interface TypedValueEvidence {
  readonly semanticType: "string" | "number" | "other";
  readonly carrierType: IrType;
  readonly semanticSource: StringSemanticEvidenceSource;
  readonly stringEncoding?: Encoding;
}

export interface TypedStringAppendEvidence {
  readonly intrinsic: "concat";
  readonly resultType: Extract<IrType, { readonly kind: "string" }>;
  readonly resultEncoding: Encoding;
}

export interface TypedStringMethodEvidence {
  readonly intrinsic: Extract<IrStringRuntimeIntrinsic, "char-at" | "char-code-at">;
  readonly omittedIndex: boolean;
  readonly indexInputType: IrType | null;
  readonly resultType: IrType;
  readonly receiverEncoding: Encoding;
  readonly resultEncoding?: Encoding;
}

const STRING_TYPE: Extract<IrType, { readonly kind: "string" }> = Object.freeze({ kind: "string" });
const F64_TYPE: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "f64" }) });

/** Claim only the non-coercive `string += string` form. */
export function proveTypedStringAppend(
  lhs: TypedValueEvidence,
  rhs: TypedValueEvidence,
): TypedStringAppendEvidence | null {
  if (lhs.semanticType !== "string" || rhs.semanticType !== "string") return null;
  if (lhs.stringEncoding === undefined || rhs.stringEncoding === undefined) return null;
  return Object.freeze({
    intrinsic: "concat",
    resultType: STRING_TYPE,
    resultEncoding: joinEncoding(lhs.stringEncoding, rhs.stringEncoding),
  });
}

/**
 * Claim only statically typed charAt/charCodeAt calls with zero or one numeric
 * argument. Dynamic receivers and coercive arguments stay outside this proof.
 */
export function proveTypedStringMethod(
  receiver: TypedValueEvidence,
  method: string,
  args: readonly IrType[],
): TypedStringMethodEvidence | null {
  if (receiver.semanticType !== "string" || receiver.stringEncoding === undefined || args.length > 1) return null;
  const intrinsic = method === "charAt" ? "char-at" : method === "charCodeAt" ? "char-code-at" : null;
  if (intrinsic === null) return null;

  const indexInputType = args[0] ?? null;
  if (indexInputType !== null) {
    const valueType = asVal(indexInputType);
    if (!valueType || (valueType.kind !== "f64" && valueType.kind !== "i32")) return null;
  }

  const resultType = IR_STRING_RUNTIME[intrinsic].result === "string" ? STRING_TYPE : F64_TYPE;
  return Object.freeze({
    intrinsic,
    omittedIndex: indexInputType === null,
    indexInputType,
    resultType,
    receiverEncoding: receiver.stringEncoding,
    ...(intrinsic === "char-at" ? { resultEncoding: receiver.stringEncoding === "ascii" ? "ascii" : "wtf16" } : {}),
  });
}
