// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { CodegenContext, FunctionContext } from "./context/types.js";
import type { Instr } from "../ir/types.js";
import { emitSymbolDescLoad, usesNativeSymbolProvider } from "./symbol-native.js";
import { nativeStringLiteralInstrs } from "./native-strings.js";
import { undefinedExternInstrs } from "./any-helpers.js";

/** The erased Symbol receiver must use the same description table as typed reads. */
export function fillSymbolDescriptionRead(ctx: CodegenContext): void {
  if (!usesNativeSymbolProvider(ctx) || ctx.symbolTypeIdx < 0) return;
  const fn = ctx.mod.functions.find((f) => f.name === "__extern_get");
  const flatten = ctx.nativeStrHelpers.get("__str_flatten");
  const equals = ctx.nativeStrHelpers.get("__str_equals");
  if (!fn || flatten === undefined || equals === undefined) return;
  const result: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: ctx.symbolTypeIdx },
    { op: "struct.get", typeIdx: ctx.symbolTypeIdx, fieldIdx: 0 },
  ];
  const fctx = {
    body: result,
    locals: fn.locals,
    params: [
      { name: "object", type: { kind: "externref" } },
      { name: "key", type: { kind: "externref" } },
    ],
    localMap: new Map(),
  } as unknown as FunctionContext;
  emitSymbolDescLoad(ctx, fctx);
  const desc = 2 + fn.locals.length;
  fn.locals.push({ name: "__symbol_description", type: { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx } });
  result.push(
    { op: "local.tee", index: desc },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" }],
      else: [{ op: "local.get", index: desc }, { op: "extern.convert_any" }],
    },
    { op: "return" },
  );
  fn.body.splice(
    0,
    0,
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: ctx.symbolTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 1 },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 1 },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
            { op: "call", funcIdx: flatten },
            ...nativeStringLiteralInstrs(ctx, "description"),
            { op: "call", funcIdx: equals },
            { op: "if", blockType: { kind: "empty" }, then: result },
          ],
        },
      ],
    },
  );
}
