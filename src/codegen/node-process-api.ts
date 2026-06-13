// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Node process API lowering for WASI.
 *
 * This keeps Node-shaped host API support out of the generic call-expression
 * compiler. User code can import `process` from `node:process`; the import
 * resolver turns that into a type-level stub, and this module compiles the
 * supported stream calls directly to WASI syscalls.
 */
import { isStringType } from "../checker/type-mapper.js";
import type { Instr, ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { noJsHost } from "./expressions/helpers.js";
import { flushLateImportShifts } from "./expressions/late-imports.js";
import {
  ensureWasiWriteAnyStringHelper,
  ensureWasiWriteArrayBufferHelper,
  ensureWasiWriteUint8ArrayHelper,
  getArrTypeIdxFromVec,
  getOrRegisterVecType,
  WASI_STDIN_BUF_START,
} from "./index.js";
import type { InnerResult } from "./shared.js";
import { compileExpression, VOID_RESULT } from "./shared.js";
import { tryEmitLinearU8StdinRead, tryEmitLinearU8StdWrite } from "./linear-uint8-codegen.js";

export function tryCompileNodeProcessCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | undefined {
  if (matchProcessStdinRead(ctx, fctx, expr)) {
    const r = emitProcessStdinRead(ctx, fctx, expr);
    if (r) return r;
  }

  // #1766: In the current WASI Preview 1 lowering, process.std*.write()
  // maps to a direct fd_write host call. Accept the Node stream backpressure
  // subscription shape so idiomatic `if (!stdout.write(...)) stdout.once("drain", cb)`
  // compiles without a JS-host EventEmitter import. Since write() returns true
  // below, the drain callback is never needed on this path. Track real WASI
  // 0.3/Preview 3 async stream semantics separately in #1774.
  if (matchProcessStdStreamDrainOnce(ctx, fctx, expr)) {
    return VOID_RESULT;
  }

  const stdoutWrite = matchProcessStdStreamWrite(ctx, fctx, expr);
  if (!stdoutWrite) return undefined;

  const { useStderr } = stdoutWrite;
  const argExpr = expr.arguments[0]!;

  // #1886 Slice B: zero-copy `process.std*.write(buf)` for a linear-backed
  // Uint8Array — fd_write reads straight from `ptr` for `len` bytes (no
  // GC→linear staging copy). Only fires for a registered linear-safe buffer.
  if (ctx.wasiFdWriteIdx !== undefined && ctx.wasiFdWriteIdx >= 0) {
    if (tryEmitLinearU8StdWrite(ctx, fctx, argExpr, ctx.wasiFdWriteIdx, useStderr)) {
      // Match the GC Uint8Array write path's contract: push `1` (write
      // succeeded) and return i32, so the expression-statement wrapper drops it
      // exactly like the GC path. (#1886)
      fctx.body.push({ op: "i32.const", value: 1 } as Instr);
      return { kind: "i32" };
    }
  }

  const argTsType = ctx.checker.getTypeAtLocation(argExpr);
  if (isStringType(argTsType)) {
    const compiled = compileExpression(ctx, fctx, argExpr);
    flushLateImportShifts(ctx, fctx);
    if (compiled && ctx.nativeStrTypeIdx >= 0) {
      if (compiled.kind === "ref_null") {
        fctx.body.push({ op: "ref.as_non_null" } as Instr);
      }
      const writeStrIdx = ensureWasiWriteAnyStringHelper(ctx, useStderr);
      if (writeStrIdx >= 0) {
        fctx.body.push({ op: "call", funcIdx: writeStrIdx } as Instr);
        fctx.body.push({ op: "i32.const", value: 1 } as Instr);
        return { kind: "i32" };
      }
    }
    if (compiled) fctx.body.push({ op: "drop" } as Instr);
    return VOID_RESULT;
  }

  const argSymName = argTsType.getSymbol?.()?.name;
  const isArrayBufferArg = argSymName === "ArrayBuffer" || argSymName === "SharedArrayBuffer";
  const elemKey: "i8_byte" | "i32_byte" | "f64" =
    noJsHost(ctx) && argSymName === "Uint8Array" ? "i8_byte" : isArrayBufferArg ? "i32_byte" : "f64";
  const elemType: ValType =
    elemKey === "i8_byte" ? { kind: "i8" } : elemKey === "i32_byte" ? { kind: "i32" } : { kind: "f64" };
  const vecTypeIdx = getOrRegisterVecType(ctx, elemKey, elemType);
  const argType = compileExpression(ctx, fctx, argExpr);
  flushLateImportShifts(ctx, fctx);

  if (argType) {
    if (argType.kind === "ref_null") {
      if ("typeIdx" in argType && argType.typeIdx !== vecTypeIdx) {
        fctx.body.push({ op: "ref.cast", typeIdx: vecTypeIdx } as Instr);
      } else {
        fctx.body.push({ op: "ref.as_non_null" } as Instr);
      }
    } else if (argType.kind === "ref" && "typeIdx" in argType && argType.typeIdx !== vecTypeIdx) {
      fctx.body.push({ op: "ref.cast", typeIdx: vecTypeIdx } as Instr);
    }
  }

  const helperIdx = isArrayBufferArg
    ? ensureWasiWriteArrayBufferHelper(ctx, vecTypeIdx, useStderr)
    : ensureWasiWriteUint8ArrayHelper(ctx, vecTypeIdx, useStderr);
  if (helperIdx >= 0) {
    fctx.body.push({ op: "call", funcIdx: helperIdx } as Instr);
    fctx.body.push({ op: "i32.const", value: 1 } as Instr);
    return { kind: "i32" };
  }
  if (argType) fctx.body.push({ op: "drop" } as Instr);
  return VOID_RESULT;
}

function isUnshadowedProcessIdentifier(fctx: FunctionContext, expr: ts.Expression): boolean {
  return (
    ts.isIdentifier(expr) &&
    expr.text === "process" &&
    !fctx.localMap.has("process") &&
    !(fctx.boxedCaptures?.has("process") ?? false)
  );
}

/**
 * #1651: recognize `process.stdout.write(x)` / `process.stderr.write(x)` under
 * --target wasi. This accepts global `process` and `import process from
 * "node:process"` after import preprocessing; local/captured shadows are left
 * alone.
 */
function matchProcessStdStreamWrite(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): { useStderr: boolean } | null {
  if (!ctx.wasi || ctx.wasiFdWriteIdx === undefined || ctx.wasiFdWriteIdx < 0) return null;
  if (expr.questionDotToken || expr.arguments.length !== 1) return null;
  const writeAccess = expr.expression;
  if (!ts.isPropertyAccessExpression(writeAccess) || writeAccess.name.text !== "write") return null;
  const streamAccess = writeAccess.expression;
  if (!ts.isPropertyAccessExpression(streamAccess)) return null;
  const streamName = streamAccess.name.text;
  if (streamName !== "stdout" && streamName !== "stderr") return null;
  if (!isUnshadowedProcessIdentifier(fctx, streamAccess.expression)) return null;
  return { useStderr: streamName === "stderr" };
}

function matchProcessStdStreamDrainOnce(ctx: CodegenContext, fctx: FunctionContext, expr: ts.CallExpression): boolean {
  if (!ctx.wasi) return false;
  if (expr.questionDotToken || expr.arguments.length !== 2) return false;
  const onceAccess = expr.expression;
  if (!ts.isPropertyAccessExpression(onceAccess) || onceAccess.name.text !== "once") return false;
  const streamAccess = onceAccess.expression;
  if (!ts.isPropertyAccessExpression(streamAccess)) return false;
  const streamName = streamAccess.name.text;
  if (streamName !== "stdout" && streamName !== "stderr") return false;
  if (!isUnshadowedProcessIdentifier(fctx, streamAccess.expression)) return false;
  const eventArg = expr.arguments[0]!;
  return ts.isStringLiteralLike(eventArg) && eventArg.text === "drain";
}

function matchProcessStdinRead(ctx: CodegenContext, fctx: FunctionContext, expr: ts.CallExpression): boolean {
  if (!ctx.wasi || ctx.wasiFdReadIdx === undefined || ctx.wasiFdReadIdx < 0) return false;
  if (expr.questionDotToken || expr.arguments.length < 1 || expr.arguments.length > 2) return false;
  const readAccess = expr.expression;
  if (!ts.isPropertyAccessExpression(readAccess) || readAccess.name.text !== "read") return false;
  const streamAccess = readAccess.expression;
  if (!ts.isPropertyAccessExpression(streamAccess) || streamAccess.name.text !== "stdin") return false;
  return isUnshadowedProcessIdentifier(fctx, streamAccess.expression);
}

function emitProcessStdinRead(ctx: CodegenContext, fctx: FunctionContext, expr: ts.CallExpression): InnerResult | null {
  const fdReadIdx = ctx.wasiFdReadIdx;
  if (fdReadIdx === undefined || fdReadIdx < 0) return null;

  // #1886 Slice B: when the buffer arg is a linear-backed Uint8Array, fd_read
  // straight into `ptr+off` — no GC↔linear element-copy loop.
  const linRead = tryEmitLinearU8StdinRead(ctx, fctx, expr, fdReadIdx);
  if (linRead !== null) return linRead;

  const bufType = compileExpression(ctx, fctx, expr.arguments[0]!);
  if (!bufType || (bufType.kind !== "ref" && bufType.kind !== "ref_null") || !("typeIdx" in bufType)) {
    if (bufType) fctx.body.push({ op: "drop" } as Instr);
    return null;
  }
  const vecTypeIdx = bufType.typeIdx;
  const vecDef = ctx.mod.types[vecTypeIdx];
  if (!vecDef || vecDef.kind !== "struct" || vecDef.fields.length < 2) {
    fctx.body.push({ op: "drop" } as Instr);
    return null;
  }
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  if (arrTypeIdx < 0) {
    fctx.body.push({ op: "drop" } as Instr);
    return null;
  }
  const arrDef = ctx.mod.types[arrTypeIdx];
  const elemKind = arrDef && arrDef.kind === "array" && arrDef.element.kind === "f64" ? "f64" : "i32";

  if (bufType.kind === "ref_null") fctx.body.push({ op: "ref.as_non_null" } as Instr);
  const vecLocal = allocLocal(fctx, `__stdin_vec_${fctx.locals.length}`, { kind: "ref", typeIdx: vecTypeIdx });
  fctx.body.push({ op: "local.set", index: vecLocal });
  const arrLocal = allocLocal(fctx, `__stdin_arr_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.get", index: vecLocal } as Instr);
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 } as Instr);
  fctx.body.push({ op: "local.set", index: arrLocal });

  const offLocal = allocLocal(fctx, `__stdin_off_${fctx.locals.length}`, { kind: "i32" });
  if (expr.arguments.length >= 2) {
    compileExpression(ctx, fctx, expr.arguments[1]!, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
  } else {
    fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  }
  fctx.body.push({ op: "local.set", index: offLocal });

  const capLocal = allocLocal(fctx, `__stdin_cap_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: vecLocal } as Instr);
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 } as Instr);
  fctx.body.push({ op: "local.get", index: offLocal } as Instr);
  fctx.body.push({ op: "i32.sub" } as Instr);
  fctx.body.push({ op: "local.set", index: capLocal });

  const needPagesLocal = allocLocal(fctx, `__stdin_needPages_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: WASI_STDIN_BUF_START } as Instr);
  fctx.body.push({ op: "local.get", index: capLocal } as Instr);
  fctx.body.push({ op: "i32.add" } as Instr);
  fctx.body.push({ op: "i32.const", value: 65535 } as Instr);
  fctx.body.push({ op: "i32.add" } as Instr);
  fctx.body.push({ op: "i32.const", value: 16 } as Instr);
  fctx.body.push({ op: "i32.shr_u" } as Instr);
  fctx.body.push({ op: "local.set", index: needPagesLocal } as Instr);
  fctx.body.push({ op: "local.get", index: needPagesLocal } as Instr);
  fctx.body.push({ op: "memory.size" } as Instr);
  fctx.body.push({ op: "i32.gt_u" } as Instr);
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "local.get", index: needPagesLocal } as Instr,
      { op: "memory.size" } as Instr,
      { op: "i32.sub" } as Instr,
      { op: "memory.grow" } as Instr,
      { op: "drop" } as Instr,
    ],
  } as Instr);

  fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  fctx.body.push({ op: "i32.const", value: WASI_STDIN_BUF_START } as Instr);
  fctx.body.push({ op: "i32.store", align: 2, offset: 0 } as Instr);
  fctx.body.push({ op: "i32.const", value: 4 } as Instr);
  fctx.body.push({ op: "local.get", index: capLocal } as Instr);
  fctx.body.push({ op: "i32.store", align: 2, offset: 0 } as Instr);

  fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  fctx.body.push({ op: "i32.const", value: 1 } as Instr);
  fctx.body.push({ op: "i32.const", value: 8 } as Instr);
  fctx.body.push({ op: "call", funcIdx: fdReadIdx } as Instr);
  fctx.body.push({ op: "drop" } as Instr);

  const nreadLocal = allocLocal(fctx, `__stdin_nread_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 8 } as Instr);
  fctx.body.push({ op: "i32.load", align: 2, offset: 0 } as Instr);
  fctx.body.push({ op: "local.set", index: nreadLocal } as Instr);

  const jLocal = allocLocal(fctx, `__stdin_j_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  fctx.body.push({ op: "local.set", index: jLocal });
  const storeByte: Instr[] = [
    { op: "i32.const", value: WASI_STDIN_BUF_START } as Instr,
    { op: "local.get", index: jLocal } as Instr,
    { op: "i32.add" } as Instr,
    { op: "i32.load8_u", align: 0, offset: 0 } as Instr,
  ];
  if (elemKind === "f64") storeByte.push({ op: "f64.convert_i32_u" } as Instr);
  const loopBody: Instr[] = [
    { op: "local.get", index: jLocal } as Instr,
    { op: "local.get", index: nreadLocal } as Instr,
    { op: "i32.ge_s" } as Instr,
    { op: "br_if", depth: 1 } as Instr,
    { op: "local.get", index: arrLocal } as Instr,
    { op: "local.get", index: offLocal } as Instr,
    { op: "local.get", index: jLocal } as Instr,
    { op: "i32.add" } as Instr,
    ...storeByte,
    { op: "array.set", typeIdx: arrTypeIdx } as Instr,
    { op: "local.get", index: jLocal } as Instr,
    { op: "i32.const", value: 1 } as Instr,
    { op: "i32.add" } as Instr,
    { op: "local.set", index: jLocal } as Instr,
    { op: "br", depth: 0 } as Instr,
  ];
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr],
  } as Instr);

  fctx.body.push({ op: "local.get", index: nreadLocal } as Instr);
  fctx.body.push({ op: "f64.convert_i32_s" } as Instr);
  return { kind: "f64" };
}
