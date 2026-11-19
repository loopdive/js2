// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Pure-Wasm `JSON.stringify(s)` of a runtime string for standalone / WASI
 * targets (#1599 Phase 2): registration only. `__json_quote_string`
 * (§25.5.4.3 `QuoteJSONString`) needs no JS host; its body is built by
 * `src/runtime/wasmgc/values/json-bodies.ts` (#7350 B2c-2), and this module
 * mints the function, records it in `funcMap` and binds the module's native
 * string types. Runtime `JSON.parse` text goes through `__json_parse_text`
 * (`json-codec-native.ts`).
 */
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S3b) stable-regime minting
import type { CodegenContext } from "./context/types.js";
import { ensureNativeStringHelpers, nativeStringType } from "./native-strings.js";
import { addFuncType } from "./registry/types.js";
import { buildJsonQuoteStringDefinition } from "../runtime/wasmgc/values/json-bodies.js";

/**
 * Emit `__json_quote_string(s: externref) -> ref $NativeString` and register it
 * in `ctx.funcMap`. Idempotent. Must run after `ensureNativeStringHelpers`
 * (called here) so `__str_flatten` exists, and before any function body that
 * calls it.
 */
export function emitJsonQuoteString(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get("__json_quote_string");
  if (existing !== undefined) return existing;
  ensureNativeStringHelpers(ctx);
  const { locals, body } = buildJsonQuoteStringDefinition({
    anyStrTypeIdx: ctx.anyStrTypeIdx,
    nativeStrTypeIdx: ctx.nativeStrTypeIdx,
    nativeStrDataTypeIdx: ctx.nativeStrDataTypeIdx,
    flattenHandle: ctx.nativeStrHelpers.get("__str_flatten")!,
  });
  const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [nativeStringType(ctx)]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__json_quote_string", funcIdx);
  // The body's locals carry no names (`{count: 1, type}`, not `LocalDef`); the encoder's `groupLocals` reads
  // only `type`, so the definition is cast as it was before the body moved (byte identity).
  pushDefinedFunc(ctx, funcIdx, {
    name: "__json_quote_string",
    typeIdx,
    locals,
    body,
    exported: false,
  } as unknown as (typeof ctx.mod.functions)[number]);
  return funcIdx;
}
