// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { NATIVE_STRING_MEMORY_READER } from "../../shared/contracts/init-marshal-helpers.js";
import type { CodegenContext } from "../context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "../func-space.js";
import { addFuncType } from "../registry/types.js";

/** Read the existing string bridge's UTF-16 memory before instance.exports exists. */
export function ensureNativeStringMemoryReader(ctx: CodegenContext): void {
  const name = NATIVE_STRING_MEMORY_READER;
  if (ctx.funcMap.has(name) || !ctx.funcMap.has("__str_to_extern")) return;
  const typeIdx = addFuncType(ctx, [{ kind: "i32" }], [{ kind: "i32" }]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(name, funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name,
    typeIdx,
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "i32.load16_u", align: 1, offset: 0 },
    ],
    exported: false,
  });
}
