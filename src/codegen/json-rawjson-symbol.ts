// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";
import { emitWasiErrorConstructor } from "./registry/error-types.js";
import { ensureSymbolCarrier } from "./symbol-native.js";

const SYMBOL_TO_STRING_ERROR = "Cannot convert a Symbol value to a string";

/**
 * Register the error and Symbol-carrier dependencies before the rawJSON parser
 * captures its function/type indices.
 */
export function prepareRawJsonSymbolToString(ctx: CodegenContext): void {
  emitWasiErrorConstructor(ctx, "SyntaxError", 1);
  emitWasiErrorConstructor(ctx, "TypeError", 1);
  ensureSymbolCarrier(ctx);
}

/**
 * Continue a rawJSON ToString dispatch whose externref has just been converted
 * to anyref. The returned sequence preserves that value for the next dispatch
 * arm, but throws the shared in-module TypeError first when it is a $Symbol.
 */
export function buildRawJsonSymbolToStringGuard(ctx: CodegenContext, anyLocal: number): Instr[] {
  addStringConstantGlobal(ctx, SYMBOL_TO_STRING_ERROR);
  const symbolTypeIdx = ctx.symbolTypeIdx;
  const typeErrorCtorIdx = ctx.funcMap.get("__new_TypeError")!;
  const exnTagIdx = ensureExnTag(ctx);

  return [
    { op: "local.tee", index: anyLocal },
    { op: "ref.test", typeIdx: symbolTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...stringConstantExternrefInstrs(ctx, SYMBOL_TO_STRING_ERROR),
        { op: "call", funcIdx: typeErrorCtorIdx },
        { op: "throw", tagIdx: exnTagIdx },
        { op: "unreachable" },
      ],
    },
    { op: "local.get", index: anyLocal },
  ];
}
