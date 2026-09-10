// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { pushBody, popBody } from "./context/bodies.js";
import { ensureObjectRuntime, ensureObjVecBuilders, reserveApplyClosure } from "./object-runtime.js";
import { ensureObjectProtoSymbolTagFn } from "./object-proto-symbol-tag.js";
import { ensureObjectProtoToStringRuntimeHelper } from "./object-proto-tostring.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { emitThrowTypeError } from "./js-errors.js";
import { ensureSymbolNativeProtoGlue, ensureBigIntNativeProtoGlue } from "./array-object-proto.js";
import { buildLazyNativeProtoGetInstrs } from "./native-proto.js";
import { ensureSymbolCarrier } from "./symbol-native.js";
import { flushLateImportShifts } from "./shared.js";

/** First-class Array.prototype.toString: Get(join), Call or intrinsic tag. */
export function emitArrayProtoToStringBody(ctx: CodegenContext, fctx: FunctionContext): ValType | null {
  ensureObjectRuntime(ctx);
  reserveApplyClosure(ctx);
  ensureObjVecBuilders(ctx);
  const tag = ensureObjectProtoToStringRuntimeHelper(ctx);
  const symbolTag = ensureObjectProtoSymbolTagFn(ctx);
  const symbolType = ensureSymbolCarrier(ctx);
  const symbolBrand = ensureSymbolNativeProtoGlue(ctx);
  const bigintBrand = ensureBigIntNativeProtoGlue(ctx);
  const symbolProto = symbolBrand === undefined ? null : buildLazyNativeProtoGetInstrs(ctx, symbolBrand);
  const bigintProto = bigintBrand === undefined ? null : buildLazyNativeProtoGetInstrs(ctx, bigintBrand);
  addStringConstantGlobal(ctx, "join");
  flushLateImportShifts(ctx, fctx);
  const primitiveTests = ["number", "string", "boolean", "bigint"].map((name) => ctx.funcMap.get("__typeof_" + name));
  const wrap = ctx.funcMap.get("__wrap_primitive_value");
  const setProto = ctx.funcMap.get("__object_setPrototypeOf");
  const get = ctx.funcMap.get("__extern_get");
  const callable = ctx.funcMap.get("__typeof_function");
  const undefinedTest = ctx.funcMap.get("__typeof_undefined");
  const apply = reserveApplyClosure(ctx);
  const { newIdx } = ensureObjVecBuilders(ctx);
  if (
    setProto === undefined ||
    symbolProto === null ||
    bigintProto === null ||
    get === undefined ||
    callable === undefined ||
    undefinedTest === undefined ||
    tag === undefined ||
    symbolTag === undefined ||
    wrap === undefined ||
    primitiveTests.some((i) => i === undefined)
  )
    return null;

  const outer = pushBody(fctx);
  emitThrowTypeError(ctx, fctx, "Array.prototype.toString called on null or undefined");
  const badReceiver = fctx.body;
  popBody(fctx, outer);
  const original = allocLocal(fctx, "__array_to_string_original", { kind: "externref" });
  const overrideTag = allocLocal(fctx, "__array_to_string_tag", { kind: "externref" });
  const join = allocLocal(fctx, "__array_to_string_join", { kind: "externref" });
  fctx.body.push(
    { op: "local.get", index: 1 },
    { op: "local.tee", index: original },
    { op: "ref.is_null" },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: undefinedTest },
    { op: "i32.or" },
    { op: "if", blockType: { kind: "empty" }, then: badReceiver },
  );
  // ToObject must precede the getter: even a strict getter/call observes a
  // wrapper, never a primitive this value. Objects retain their identity.
  for (const [i, test] of primitiveTests.entries()) {
    fctx.body.push({ op: "local.get", index: 1 }, { op: "call", funcIdx: test! });
    if (i !== 0) fctx.body.push({ op: "i32.or" });
  }
  fctx.body.push(
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: symbolType },
    { op: "i32.or" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: wrap },
        { op: "local.set", index: 1 },
      ],
    },
    { op: "local.get", index: original },
    { op: "call", funcIdx: primitiveTests[3]! },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: 1 }, ...bigintProto, { op: "call", funcIdx: setProto }, { op: "drop" }],
    },
    { op: "local.get", index: original },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: symbolType },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: 1 }, ...symbolProto, { op: "call", funcIdx: setProto }, { op: "drop" }],
    },
    { op: "local.get", index: 1 },
    ...stringConstantExternrefInstrs(ctx, "join"),
    { op: "call", funcIdx: get },
    { op: "local.tee", index: join },
    { op: "call", funcIdx: callable },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [
        { op: "local.get", index: join },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: newIdx },
        { op: "call", funcIdx: apply },
      ],
      else: [
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: symbolTag },
        { op: "local.tee", index: overrideTag },
        { op: "ref.is_null" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } },
          then: [{ op: "ref.null.extern" }, { op: "local.get", index: 1 }, { op: "call", funcIdx: tag }],
          else: [{ op: "local.get", index: overrideTag }],
        },
      ],
    },
  );
  return { kind: "externref" };
}
