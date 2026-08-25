// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Preserve a native Wasm TypedArray's concrete brand at the JS-host boundary.
 *
 * Numeric TypedArrays and ordinary Arrays intentionally share the same compact
 * `$Vec` carrier. Once such a value is widened to `any`, the host cannot infer
 * from the opaque WasmGC struct whether `.buffer` should exist. Register only
 * values produced by a TypedArray constructor; plain vecs remain unbranded.
 */
import type { ValType } from "../../ir/types.js";
import { ts } from "../../ts-api.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { noJsHost } from "./helpers.js";
import { ensureLateImport, flushLateImportShifts } from "./late-imports.js";

// Runtime contract: keep in lock-step with _COMPILED_TYPED_ARRAY_CTORS in
// runtime.ts. Zero is deliberately not a valid brand.
const TYPED_ARRAY_HOST_TAGS: Readonly<Record<string, number>> = {
  Int8Array: 1,
  Uint8Array: 2,
  Uint8ClampedArray: 3,
  Int16Array: 4,
  Uint16Array: 5,
  Int32Array: 6,
  Uint32Array: 7,
  Float32Array: 8,
  Float64Array: 9,
  BigInt64Array: 10,
  BigUint64Array: 11,
};

/**
 * Whether evaluating a dynamic-looking constructor argument is nevertheless
 * guaranteed to produce a primitive before `%TypedArray%` sees it. Arithmetic
 * operators run ToPrimitive on their operands and return a primitive (or
 * throw), so their result can never be an ArrayBuffer or array-like object.
 *
 * This carrier fact is intentionally narrower than "number-like": `+` may
 * produce a string or bigint. The existing TypedArray count path still applies
 * the constructor's numeric coercion; this helper only prevents an arithmetic
 * result typed as `any` from being mistaken for a host buffer/object carrier.
 */
export function typedArrayCtorArgIsArithmeticPrimitive(expr: ts.Expression): boolean {
  let value = expr;
  while (
    ts.isParenthesizedExpression(value) ||
    ts.isAsExpression(value) ||
    ts.isSatisfiesExpression(value) ||
    ts.isNonNullExpression(value) ||
    ts.isTypeAssertionExpression(value)
  ) {
    value = value.expression;
  }
  if (ts.isPrefixUnaryExpression(value) || ts.isPostfixUnaryExpression(value)) return true;
  if (!ts.isBinaryExpression(value)) return false;
  switch (value.operatorToken.kind) {
    case ts.SyntaxKind.PlusToken:
    case ts.SyntaxKind.MinusToken:
    case ts.SyntaxKind.AsteriskToken:
    case ts.SyntaxKind.SlashToken:
    case ts.SyntaxKind.PercentToken:
    case ts.SyntaxKind.AsteriskAsteriskToken:
    case ts.SyntaxKind.LessThanLessThanToken:
    case ts.SyntaxKind.GreaterThanGreaterThanToken:
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
    case ts.SyntaxKind.AmpersandToken:
    case ts.SyntaxKind.BarToken:
    case ts.SyntaxKind.CaretToken:
      return true;
    default:
      return false;
  }
}

export function isHostTypedArrayCarrierName(name: string | undefined): name is string {
  return name !== undefined && TYPED_ARRAY_HOST_TAGS[name] !== undefined;
}

/**
 * Consume the freshly-created native TypedArray carrier on the stack, register
 * its concrete TypedArray brand with the host, then leave the same carrier on
 * the stack. Host-backed TypedArrays do not call this helper because they retain
 * their native JS brand; standalone/WASI remains import-free and byte-identical.
 */
export function emitHostTypedArrayCarrierRegistration(
  ctx: CodegenContext,
  fctx: FunctionContext,
  ctorName: string,
  resultType: ValType,
): void {
  if (noJsHost(ctx)) return;
  const tag = TYPED_ARRAY_HOST_TAGS[ctorName];
  if (tag === undefined) return;

  ensureLateImport(ctx, "__register_typed_array", [{ kind: "externref" }, { kind: "i32" }], []);
  flushLateImportShifts(ctx, fctx);
  const registerIdx = ctx.funcMap.get("__register_typed_array");
  if (registerIdx === undefined) return;

  const carrierLocal = allocLocal(fctx, `__typed_array_carrier_${fctx.locals.length}`, resultType);
  fctx.body.push(
    { op: "local.set", index: carrierLocal },
    { op: "local.get", index: carrierLocal },
    { op: "extern.convert_any" },
    { op: "i32.const", value: tag },
    { op: "call", funcIdx: registerIdx },
    { op: "local.get", index: carrierLocal },
  );
}
