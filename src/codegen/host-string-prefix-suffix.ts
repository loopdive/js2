// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Host-mode fixed prefix/suffix lowering.
 *
 * A compile-time string needle can use the engine's `wasm:js-string`
 * primitives directly: length guard, one bounded substring, then equality.
 * That keeps the comparison inside Wasm/V8 instead of crossing through the
 * general JavaScript String-method adapter on every iteration.
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import { staticConstStringValues } from "./analysis/static-string-values.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { addStringImports } from "./registry/imports.js";
import { coerceType, compileExpression } from "./shared.js";

export function tryCompileHostStringPredicate(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  method: string,
  eligible: boolean,
): ValType | null {
  if (
    ctx.nativeStrings ||
    (method !== "includes" && method !== "startsWith" && method !== "endsWith") ||
    expr.arguments.length !== 1
  ) {
    return null;
  }

  const searchValues = staticConstStringValues(ctx, expr.arguments[0]!);
  const receiverValues = staticConstStringValues(ctx, propAccess.expression);
  if (receiverValues && searchValues && new Set(searchValues).size === 1) {
    const search = searchValues[0]!;
    const results = new Set(
      receiverValues.map((value) =>
        method === "includes"
          ? value.includes(search)
          : method === "startsWith"
            ? value.startsWith(search)
            : value.endsWith(search),
      ),
    );
    if (results.size === 1) {
      const receiver = compileExpression(ctx, fctx, propAccess.expression);
      if (receiver) fctx.body.push({ op: "drop" });
      const argument = compileExpression(ctx, fctx, expr.arguments[0]!);
      if (argument) fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "i32.const", value: results.values().next().value ? 1 : 0 });
      return { kind: "i32", boolean: true };
    }
  }
  if (
    !eligible ||
    process.env.JS2WASM_HOST_STRING_PREFIX_SUFFIX === "0" ||
    method === "includes" ||
    !searchValues ||
    new Set(searchValues).size !== 1
  ) {
    return null;
  }

  addStringImports(ctx);
  const lengthIdx = ctx.jsStringImports.get("length");
  const substringIdx = ctx.jsStringImports.get("substring");
  const equalsIdx = ctx.jsStringImports.get("equals");
  if (lengthIdx === undefined || substringIdx === undefined || equalsIdx === undefined) return null;

  const recvType = compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
  if (recvType && recvType.kind !== "externref" && recvType.kind !== "ref_extern") {
    coerceType(ctx, fctx, recvType, { kind: "externref" });
  }
  const recvLocal = allocLocal(fctx, `__host_${method}_recv_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: recvLocal });

  const needleType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
  if (needleType && needleType.kind !== "externref" && needleType.kind !== "ref_extern") {
    coerceType(ctx, fctx, needleType, { kind: "externref" });
  }
  const needleLocal = allocLocal(fctx, `__host_${method}_needle_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: needleLocal });

  const needleLength = searchValues[0]!.length;
  const receiverLengthLocal = allocLocal(fctx, `__host_${method}_len_${fctx.locals.length}`, { kind: "i32" });
  const lengthProven =
    receiverValues !== undefined && receiverValues.every((receiver) => receiver.length >= needleLength);
  if (method === "endsWith" || !lengthProven) {
    fctx.body.push({ op: "local.get", index: recvLocal });
    fctx.body.push({ op: "call", funcIdx: lengthIdx });
    fctx.body.push({ op: lengthProven ? "local.set" : "local.tee", index: receiverLengthLocal });
  }
  if (!lengthProven) {
    fctx.body.push({ op: "i32.const", value: needleLength });
    fctx.body.push({ op: "i32.ge_u" });
  }

  const startInstrs: Instr[] =
    method === "startsWith"
      ? [{ op: "i32.const", value: 0 }]
      : [{ op: "local.get", index: receiverLengthLocal }, { op: "i32.const", value: needleLength }, { op: "i32.sub" }];
  const endInstrs: Instr[] =
    method === "startsWith"
      ? [{ op: "i32.const", value: needleLength }]
      : [{ op: "local.get", index: receiverLengthLocal }];
  const matchInstrs: Instr[] = [
    { op: "local.get", index: recvLocal },
    ...startInstrs,
    ...endInstrs,
    { op: "call", funcIdx: substringIdx },
    { op: "local.get", index: needleLocal },
    { op: "call", funcIdx: equalsIdx },
  ];
  if (lengthProven) {
    fctx.body.push(...matchInstrs);
  } else {
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: matchInstrs,
      else: [{ op: "i32.const", value: 0 }],
    });
  }
  return { kind: "i32", boolean: true };
}
