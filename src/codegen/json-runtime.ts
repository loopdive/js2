// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Pure-Wasm runtime JSON helpers for standalone / WASI targets (#1599 Phase 2):
 * registration only. Phase 2A (`json-standalone.ts`) folds *statically known*
 * JSON literal graphs at compile time; the two helpers here act on a runtime
 * string value and need no JS host — `JSON.stringify(s)` of a string
 * (`__json_quote_string`, §25.5.4.3 `QuoteJSONString`) and `JSON.parse` of a
 * single primitive (`__json_parse_primitive`). Their bodies are built by
 * `src/runtime/wasmgc/values/json-bodies.ts` (#7350 B2c-2); this module mints
 * the function, records it in `funcMap` and binds the module's native string
 * and `$AnyValue` types.
 *
 * The remaining dynamic Phase 2 surface — `JSON.stringify` of runtime
 * object/array graphs and `JSON.parse` of non-primitive text — is documented as
 * a follow-up in the #1599 issue file.
 */
import type { ValType } from "../ir/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S3b) stable-regime minting
import { ensureAnyValueType } from "./any-helpers.js";
import type { CodegenContext } from "./context/types.js";
import { ensureNativeStringHelpers, nativeStringType } from "./native-strings.js";
import { addFuncType } from "./registry/types.js";
import {
  buildJsonParsePrimitiveDefinition,
  buildJsonQuoteStringDefinition,
  type JsonBodyBindings,
  type JsonBodyDefinition,
} from "../runtime/wasmgc/values/json-bodies.js";

/** The native string resources both bodies bind. Call after `ensureNativeStringHelpers`. */
function jsonBodyBindings(ctx: CodegenContext): JsonBodyBindings {
  return {
    anyStrTypeIdx: ctx.anyStrTypeIdx,
    nativeStrTypeIdx: ctx.nativeStrTypeIdx,
    nativeStrDataTypeIdx: ctx.nativeStrDataTypeIdx,
    flattenHandle: ctx.nativeStrHelpers.get("__str_flatten")!,
  };
}

/** Mint `name : (externref) -> result`, record it in `funcMap`, and push its definition. */
function registerJsonHelper(
  ctx: CodegenContext,
  name: string,
  result: ValType,
  { locals, body }: JsonBodyDefinition,
): number {
  const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [result]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(name, funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name,
    typeIdx,
    locals,
    body,
    exported: false,
  } as unknown as (typeof ctx.mod.functions)[number]);
  return funcIdx;
}

/**
 * Emit `__json_quote_string(s: externref) -> externref` and register it in
 * `ctx.funcMap`. Idempotent. Must run after `ensureNativeStringHelpers` (called
 * here) so `__str_flatten` exists, and before any function body that calls it.
 *
 * The body is `buildJsonQuoteStringDefinition` (native runtime, #7350 B2c-2).
 */
export function emitJsonQuoteString(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get("__json_quote_string");
  if (existing !== undefined) return existing;
  ensureNativeStringHelpers(ctx);
  return registerJsonHelper(
    ctx,
    "__json_quote_string",
    nativeStringType(ctx),
    buildJsonQuoteStringDefinition(jsonBodyBindings(ctx)),
  );
}

/**
 * Emit `__json_parse_primitive(s: externref) -> ref $AnyValue` and register it
 * in `ctx.funcMap`. Idempotent. Parses a runtime string holding a single JSON
 * primitive (number / `true` / `false` / `null`) entirely in Wasm — no
 * `env::JSON_parse` host import — and boxes the result into the host-free
 * `$AnyValue` tagged union (#1599 Phase 2; the tag table is in `json-bodies.ts`).
 *
 * The caller (`tryEmitJsonParsePrimitive` in expressions/calls.ts) gates this
 * on the native regime and a string-typed argument, and returns the
 * `ref $AnyValue` type so the existing AnyValue→primitive coercion path in
 * type-coercion.ts unboxes it to number / boolean as the consumer requires.
 *
 * Must run after `ensureNativeStringHelpers` (called here) so `__str_flatten`
 * exists, and before any function body that calls it.
 *
 * Spec: ECMA-262 §25.5.2 `JSON.parse` / `ParseJSON`, ECMA-404 JSON grammar.
 * The body is `buildJsonParsePrimitiveDefinition` (native runtime, #7350 B2c-2).
 */
export function emitJsonParsePrimitive(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get("__json_parse_primitive");
  if (existing !== undefined) return existing;
  ensureNativeStringHelpers(ctx);
  ensureAnyValueType(ctx);
  const anyValueTypeIdx = ctx.anyValueTypeIdx;
  return registerJsonHelper(
    ctx,
    "__json_parse_primitive",
    { kind: "ref", typeIdx: anyValueTypeIdx },
    buildJsonParsePrimitiveDefinition({ ...jsonBodyBindings(ctx), anyValueTypeIdx }),
  );
}
