// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { popBody, pushBody } from "./context/bodies.js";
import { ensureObjectRuntime, ensureObjVecBuilders, reserveApplyClosure } from "./object-runtime.js";
import { emitNativeReflectTargetGuard } from "./reflect-target-guard.js";
import { emitThrowTypeError } from "./js-errors.js";

/** First-class Function.prototype.apply, using the ordinary callable bridge. */
export function emitFunctionProtoApplyBody(ctx: CodegenContext, fctx: FunctionContext): ValType | null {
  ensureObjectRuntime(ctx);
  const apply = reserveApplyClosure(ctx);
  const { newIdx, pushIdx } = ensureObjVecBuilders(ctx);
  const callable = ctx.funcMap.get("__typeof_function");
  const undefinedTest = ctx.funcMap.get("__typeof_undefined");
  const length = ctx.funcMap.get("__extern_length");
  const getIndex = ctx.funcMap.get("__extern_get_idx");
  if (callable === undefined || undefinedTest === undefined || length === undefined || getIndex === undefined)
    return null;

  // Native-method ABI: self=0, target=1, thisArg=2, argArray=3.
  // Check the target before observing argArray.length or any indexed getter.
  const outer = pushBody(fctx);
  emitThrowTypeError(ctx, fctx, "Function.prototype.apply target is not callable");
  const badTarget = fctx.body;
  popBody(fctx, outer);
  fctx.body.push(
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: callable },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: badTarget },
  );
  const list = allocLocal(fctx, "__apply_list", { kind: "externref" });
  const count = allocLocal(fctx, "__apply_length", { kind: "f64" });
  const index = allocLocal(fctx, "__apply_index", { kind: "f64" });
  fctx.body.push({ op: "call", funcIdx: newIdx }, { op: "local.set", index: list });

  const saved = pushBody(fctx);
  emitNativeReflectTargetGuard(ctx, fctx, 3, "Function.prototype.apply argument list is not an object");
  fctx.body.push(
    { op: "local.get", index: 3 },
    { op: "call", funcIdx: length },
    { op: "local.set", index: count },
    { op: "f64.const", value: 0 },
    { op: "local.set", index },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index },
            { op: "local.get", index: count },
            { op: "f64.ge" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: list },
            { op: "local.get", index: 3 },
            { op: "local.get", index },
            { op: "call", funcIdx: getIndex },
            { op: "call", funcIdx: pushIdx },
            { op: "local.get", index },
            { op: "f64.const", value: 1 },
            { op: "f64.add" },
            { op: "local.set", index },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
  );
  const materialize: Instr[] = fctx.body;
  popBody(fctx, saved);
  // Unlike Reflect.apply, null and undefined denote an empty argument list.
  fctx.body.push(
    { op: "local.get", index: 3 },
    { op: "ref.is_null" },
    { op: "local.get", index: 3 },
    { op: "call", funcIdx: undefinedTest },
    { op: "i32.or" },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: materialize },
    { op: "local.get", index: 1 },
    { op: "local.get", index: 2 },
    { op: "local.get", index: list },
    { op: "call", funcIdx: apply },
  );
  return { kind: "externref" };
}
