// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { flushLateImportShifts } from "./shared.js";

/** Reified hasOwnProperty: ToPropertyKey precedes the nullish-this error. */
export function emitObjectProtoHasOwnBody(ctx: CodegenContext, fctx: FunctionContext): ValType | null {
  if (!ctx.standalone) return null;
  ensureObjectRuntime(ctx);
  const invalidThis = buildThrowJsErrorInstrs(ctx, "TypeError", "hasOwnProperty called on null or undefined", {
    flush: fctx,
  });
  flushLateImportShifts(ctx, fctx);
  const toKey = ctx.funcMap.get("__to_property_key");
  const nullish = ctx.funcMap.get("__nullish_to_null");
  const hasOwn = ctx.funcMap.get("__hasOwnProperty");
  if (toKey === undefined || nullish === undefined || hasOwn === undefined) return null;
  const key = allocLocal(fctx, "has_own_key", { kind: "externref" });
  fctx.body.push(
    { op: "local.get", index: 2 },
    { op: "call", funcIdx: toKey },
    { op: "local.set", index: key },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: nullish },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: invalidThis },
    { op: "local.get", index: 1 },
    { op: "local.get", index: key },
    { op: "call", funcIdx: hasOwn },
  );
  return { kind: "i32", boolean: true };
}
