// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Host-free `String.prototype.repeat` support for the linear-memory backend
 * (#3922).
 *
 * The linear backend stores strings as `[header:8][byteLength:u32][UTF-8]`.
 * Repeat therefore copies the immutable byte payload into one freshly
 * allocated record. The count stays f64 until this helper applies
 * ToIntegerOrInfinity; converting it at the call site with `i32.trunc_f64_s`
 * would incorrectly trap on NaN and would test negative fractions before
 * truncation.
 *
 * Linear JS exception handling is still tracked by #1838/#1937. Until that
 * substrate exists, the two spec RangeError paths (negative/+Infinity and an
 * implementation-size overflow) use a deterministic `unreachable` trap. The
 * guard runs before allocation, so an impossible request cannot wrap an i32
 * length or partially overwrite the arena.
 */

import { ts, forEachChild } from "../ts-api.js";
import {
  LINEAR_STRING_PAYLOAD_PREFIX_BYTES,
  LINEAR_STRING_PAYLOAD_SIZE_OFFSET,
} from "../ir/analysis/linear-memory-plan.js";
import type { Instr, WasmModule } from "../ir/types.js";
import type { LinearContext, LinearFuncContext } from "./context.js";

export const LINEAR_STRING_REPEAT_FN = "__str_repeat";

const LINEAR_MEMORY_MAX_BYTES = 256 * 65_536;
const STRING_RECORD_HEADER_BYTES = 12;
const MAX_STRING_BYTE_LENGTH = LINEAR_MEMORY_MAX_BYTES - STRING_RECORD_HEADER_BYTES;

type CompileExpression = (ctx: LinearContext, fctx: LinearFuncContext, expr: ts.Expression) => void;

/** True when direct linear codegen can encounter a `.repeat(...)` call. */
export function sourceMayUseLinearStringRepeat(sourceFile: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "repeat"
    ) {
      found = true;
      return;
    }
    forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** Emit the direct call after the string-receiver proof in `compileMethodCall`. */
export function compileLinearStringRepeatCall(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  receiver: ts.Expression,
  count: ts.Expression | undefined,
  compileExpression: CompileExpression,
  compileCountToF64: CompileExpression,
): void {
  compileExpression(ctx, fctx, receiver);
  if (count === undefined) fctx.body.push({ op: "f64.const", value: 0 });
  else compileCountToF64(ctx, fctx, count);
  // Resolve after operand compilation: it may register/insert functions, and
  // a funcIdx captured before that work can become stale (#2150 class-3).
  const funcIdx = ctx.funcMap.get(LINEAR_STRING_REPEAT_FN);
  if (funcIdx === undefined) throw new Error("linear string repeat runtime was not registered");
  fctx.body.push({ op: "call", funcIdx });
}

function findFuncIndex(mod: WasmModule, name: string): number {
  const numImports = mod.imports.filter((entry) => entry.desc.kind === "func").length;
  const index = mod.functions.findIndex((func) => func.name === name);
  if (index < 0) throw new Error(`linear string repeat dependency missing: ${name}`);
  return numImports + index;
}

/** Register the `(string, f64 count) -> string` native repeat kernel. */
export function addLinearStringRepeatRuntime(mod: WasmModule): void {
  if (mod.functions.some((func) => func.name === LINEAR_STRING_REPEAT_FN)) return;

  const mallocIdx = findFuncIndex(mod, "__malloc");
  const typeIdx = mod.types.length;
  mod.types.push({
    kind: "func",
    name: `$type_${LINEAR_STRING_REPEAT_FN}`,
    params: [{ kind: "i32" }, { kind: "f64" }],
    results: [{ kind: "i32" }],
  });

  // params: string(0), count(1)
  // locals: integerCount(2:f64), sourceLen(3), resultLen(4), result(5), i(6)
  const integerCount = 2;
  const sourceLen = 3;
  const resultLen = 4;
  const result = 5;
  const i = 6;
  const body: Instr[] = [
    // n = ToIntegerOrInfinity(count). f64.trunc preserves NaN and infinities;
    // NaN is normalized to +0 below, as required by ToIntegerOrInfinity.
    { op: "local.get", index: 1 },
    { op: "f64.trunc" },
    { op: "local.set", index: integerCount },

    // §22.1.3.18: n < 0 or n = +Infinity throws RangeError. Testing the
    // truncated value makes -0.5 become -0 rather than a false RangeError.
    { op: "local.get", index: integerCount },
    { op: "f64.const", value: 0 },
    { op: "f64.lt" },
    { op: "local.get", index: integerCount },
    { op: "f64.const", value: Infinity },
    { op: "f64.eq" },
    { op: "i32.or" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "unreachable" }],
      else: [],
    },

    // ToIntegerOrInfinity(NaN) = +0.
    { op: "local.get", index: integerCount },
    { op: "local.get", index: integerCount },
    { op: "f64.ne" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "f64.const", value: 0 },
        { op: "local.set", index: integerCount },
      ],
      else: [],
    },

    // The validity check precedes the empty-string fast path: "".repeat(-1)
    // must still fail. A valid repeat of an empty string can reuse its record.
    { op: "local.get", index: 0 },
    { op: "i32.load", align: 2, offset: 8 },
    { op: "local.tee", index: sourceLen },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: 0 }, { op: "return" }],
      else: [],
    },

    // A count of one preserves the immutable source record and avoids an
    // allocation. String primitives have no observable pointer identity.
    { op: "local.get", index: integerCount },
    { op: "f64.const", value: 1 },
    { op: "f64.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: 0 }, { op: "return" }],
      else: [],
    },

    // Compute in f64 and reject before narrowing. The cap mirrors the module's
    // 256-page memory maximum; lower remaining capacity is handled by __malloc
    // as the ordinary OOM trap.
    { op: "local.get", index: sourceLen },
    { op: "f64.convert_i32_u" },
    { op: "local.get", index: integerCount },
    { op: "f64.mul" },
    { op: "local.tee", index: integerCount },
    { op: "f64.const", value: MAX_STRING_BYTE_LENGTH },
    { op: "f64.gt" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "unreachable" }],
      else: [],
    },
    { op: "local.get", index: integerCount },
    { op: "i32.trunc_f64_u" },
    { op: "local.set", index: resultLen },

    // Allocate and initialize the canonical linear-string record.
    { op: "local.get", index: resultLen },
    { op: "i32.const", value: STRING_RECORD_HEADER_BYTES },
    { op: "i32.add" },
    { op: "call", funcIdx: mallocIdx },
    { op: "local.set", index: result },
    { op: "local.get", index: result },
    { op: "local.get", index: resultLen },
    { op: "i32.const", value: LINEAR_STRING_PAYLOAD_PREFIX_BYTES },
    { op: "i32.add" },
    { op: "i32.store", align: 2, offset: LINEAR_STRING_PAYLOAD_SIZE_OFFSET },
    { op: "local.get", index: result },
    { op: "local.get", index: resultLen },
    { op: "i32.store", align: 2, offset: 8 },

    // result[i] = source[i % sourceLen]. This copies UTF-8 bytes, so repeating
    // a non-ASCII string preserves its exact code-point/code-unit sequence.
    { op: "i32.const", value: 0 },
    { op: "local.set", index: i },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: i },
            { op: "local.get", index: resultLen },
            { op: "i32.ge_u" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: result },
            { op: "local.get", index: i },
            { op: "i32.add" },
            { op: "local.get", index: 0 },
            { op: "local.get", index: i },
            { op: "local.get", index: sourceLen },
            { op: "i32.rem_u" },
            { op: "i32.add" },
            { op: "i32.load8_u", align: 0, offset: 12 },
            { op: "i32.store8", align: 0, offset: 12 },
            { op: "local.get", index: i },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: i },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    { op: "local.get", index: result },
  ];

  mod.functions.push({
    name: LINEAR_STRING_REPEAT_FN,
    typeIdx,
    locals: [
      { name: "integerCount", type: { kind: "f64" } },
      { name: "sourceLen", type: { kind: "i32" } },
      { name: "resultLen", type: { kind: "i32" } },
      { name: "result", type: { kind: "i32" } },
      { name: "i", type: { kind: "i32" } },
    ],
    body,
    exported: false,
  });
}
