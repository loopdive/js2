// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2657 — RAW `wasi_snapshot_preview1` fd_read / fd_write passthrough + the
 * minimal linear-memory accessors a raw-WASI module needs.
 *
 * The MOST honest pure-WASI-Preview-1 expression of fd-based I/O. Two recognizer
 * families on two HONESTLY-SEPARATED source-import surfaces (so the source never
 * mislabels a compiler intrinsic as a WASI host function), each gated on its own
 * context set so both are byte-neutral for any program that doesn't import them:
 *
 *  1. `fd_read` / `fd_write`, imported from `"wasi_snapshot_preview1"` (the REAL
 *     WASI Preview-1 core module) → a DIRECT `call` of the registered WASI
 *     import. The user supplies the four raw i32 arguments (an iovec pointer,
 *     iovec count, and a result-count pointer) exactly as the WASI ABI specifies;
 *     the program owns linear memory and lays out the iovec itself. The import is
 *     registered in `registerWasiImports` (index.ts), which routes the binding to
 *     the SAME `ctx.wasiFdReadIdx` / `ctx.wasiFdWriteIdx` import the #2037
 *     direct-fd infra already wires — no duplicate import. (Gated on
 *     `ctx.wasiRawImports`.)
 *
 *       import { fd_read, fd_write } from "wasi_snapshot_preview1";
 *       fd_read (fd, iovs, iovs_len, nread)    -> i32 (errno)
 *       fd_write(fd, iovs, iovs_len, nwritten) -> i32 (errno)
 *
 *  2. `store32` / `load32` / `store8` / `load8`, imported from `"wasm:memory"` (a
 *     js2wasm INTRINSIC namespace, mirroring `wasm:js-string`) → INLINE WASM
 *     memory ops (`i32.store` / `i32.load` / `i32.store8` / `i32.load8_u`). These
 *     are NOT imports — no host provides a `wasm:memory.store32`; they lower to a
 *     single memory instruction over the module's own exported `memory`, the
 *     linear-memory access surface that lets a raw-WASI module lay out its iovec
 *     `{buf, buf_len}` + nread/nwritten slot and move bytes without a GC
 *     roundtrip. Raw linear-memory access is inherent to the WASM target with no
 *     Node/Web equivalent, so it is honestly namespaced AWAY from the WASI host
 *     surface. (Gated on `ctx.wasiMemAccessors`.)
 *
 *       import { store32, load32, store8, load8 } from "wasm:memory";
 *       store32(addr, value) -> void   (i32.store,   4-byte LE)
 *       load32 (addr)        -> i32     (i32.load,    4-byte LE)
 *       store8 (addr, value) -> void   (i32.store8,  low byte)
 *       load8  (addr)        -> i32     (i32.load8_u, zero-extended)
 *
 * No `node:fs` surface at all (loopdive/js2wasm#389).
 */
import type { Instr } from "../ir/types.js";
import { ts } from "../ts-api.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { flushLateImportShifts } from "./expressions/late-imports.js";
import type { InnerResult } from "./shared.js";
import { coerceType, compileExpression, VOID_RESULT } from "./shared.js";

/** The raw WASI Preview-1 fd functions, recognized by import name → a `call`. */
const RAW_WASI_FD_FUNCS = new Set(["fd_read", "fd_write"]);

/** The inline linear-memory accessors, recognized by name → a single memory op. */
const RAW_WASI_MEM_ACCESSORS = new Set(["store32", "load32", "store8", "load8"]);

/**
 * Compile one call argument as i32. Native i32-annotated args land here
 * directly; an f64-typed arg is coerced. Used for both the fd-syscall args and
 * the memory-accessor address/value.
 */
function emitI32Arg(ctx: CodegenContext, fctx: FunctionContext, argExpr: ts.Expression): void {
  const argType = compileExpression(ctx, fctx, argExpr, { kind: "i32" });
  flushLateImportShifts(ctx, fctx);
  if (argType) coerceType(ctx, fctx, argType, { kind: "i32" });
}

/**
 * Recognize + lower a call to a raw `wasi_snapshot_preview1` binding —
 * `fd_read`/`fd_write` (→ a direct WASI import call) or one of the inline
 * linear-memory accessors `store32`/`load32`/`store8`/`load8` (→ a single memory
 * instruction). Returns the result, or `undefined` when this isn't a raw-WASI
 * call we handle (the generic compiler then proceeds). Byte-neutral for any
 * program that doesn't import the raw module — `ctx.wasiRawImports` is empty, so
 * the early returns fire immediately.
 */
export function tryCompileRawWasiCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | undefined {
  // (#4238) Two regimes own a linear memory at index 0: `--target wasi` (this
  // module defines/exports it) and `importMemory` (a PEER wasm module owns and
  // exports it, this module imports it — the `--link node:fs` topology). The
  // inline `wasm:memory` accessors are valid in both; the `fd_read`/`fd_write`
  // passthrough below stays WASI-only (its import indices are only registered
  // by registerWasiImports, and the `importIdx === undefined` guard bails).
  if (!ctx.wasi && ctx.importMemory === undefined) return undefined;
  if (ctx.wasiRawImports.size === 0 && ctx.wasiMemAccessors.size === 0) return undefined;
  if (expr.questionDotToken) return undefined;
  if (!ts.isIdentifier(expr.expression)) return undefined;
  const callee = expr.expression.text;

  // `fd_read`/`fd_write` are intercepted only when imported from
  // `wasi_snapshot_preview1`; the inline accessors only when imported from
  // `wasm:memory`. The two surfaces are tracked separately, so a name that
  // matches the family but came from the WRONG module is left to the generic
  // path. Also skip any local shadow — a `function fd_read(){}` /
  // `function load8(){}` must NOT be intercepted.
  const isFdFunc = RAW_WASI_FD_FUNCS.has(callee) && ctx.wasiRawImports.has(callee);
  const isMemAccessor = RAW_WASI_MEM_ACCESSORS.has(callee) && ctx.wasiMemAccessors.has(callee);
  if (!isFdFunc && !isMemAccessor) return undefined;
  if (fctx.localMap.has(callee) || (fctx.boxedCaptures?.has(callee) ?? false)) return undefined;

  if (isFdFunc) {
    const importIdx = callee === "fd_read" ? ctx.wasiFdReadIdx : ctx.wasiFdWriteIdx;
    // Registered up-front in registerWasiImports when the raw binding is present.
    // If it somehow wasn't (defensive), bail to the generic path.
    if (importIdx === undefined || importIdx < 0) return undefined;
    // Raw WASI fd_read/fd_write take exactly four i32 args. A wrong-arity call is
    // not the raw syscall shape — defer to the generic path.
    if (expr.arguments.length !== 4) return undefined;
    for (const argExpr of expr.arguments) emitI32Arg(ctx, fctx, argExpr);
    fctx.body.push({ op: "call", funcIdx: importIdx });
    // The WASI call leaves the errno (i32) on the stack.
    return { kind: "i32" };
  }

  // Inline linear-memory accessor.
  return emitMemAccessor(ctx, fctx, expr, callee);
}

/**
 * Lower a `store32`/`load32`/`store8`/`load8` call to a single WASM memory
 * instruction over the module's own exported `memory`. Stores return
 * `VOID_RESULT` (nothing on the stack); loads return an i32.
 */
function emitMemAccessor(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  callee: string,
): InnerResult | undefined {
  const isStore = callee === "store32" || callee === "store8";
  // store(addr, value): 2 args; load(addr): 1 arg. Wrong arity → generic path.
  if (isStore) {
    if (expr.arguments.length !== 2) return undefined;
    emitI32Arg(ctx, fctx, expr.arguments[0]!); // addr
    emitI32Arg(ctx, fctx, expr.arguments[1]!); // value
    fctx.body.push(
      callee === "store32" ? { op: "i32.store", align: 0, offset: 0 } : { op: "i32.store8", align: 0, offset: 0 },
    );
    return VOID_RESULT;
  }

  if (expr.arguments.length !== 1) return undefined;
  emitI32Arg(ctx, fctx, expr.arguments[0]!); // addr
  fctx.body.push(
    callee === "load32" ? { op: "i32.load", align: 0, offset: 0 } : { op: "i32.load8_u", align: 0, offset: 0 },
  );
  return { kind: "i32" };
}
