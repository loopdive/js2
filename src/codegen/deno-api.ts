// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Deno synchronous stdio lowering for WASI (#2684).
 *
 * Deno is the other runtime in loopdive/js2wasm#389's "runs under the runtime + also
 * compiles to wasi" story. Its synchronous stdio is a different SURFACE from
 * `node:fs` but the same PRIMITIVE: fd-based blocking IO over fd 0/1/2.
 *
 *   Deno.stdin.readSync(p: Uint8Array): number | null   // bytes read, null @EOF
 *   Deno.stdout.writeSync(p: Uint8Array): number         // bytes written (fd 1)
 *   Deno.stderr.writeSync(p: Uint8Array): number         // bytes written (fd 2)
 *
 * `Deno` is an AMBIENT GLOBAL (not an import), so it is recognized by the
 * member-call SHAPE (`Deno.stdin.readSync` / `Deno.{stdout,stderr}.writeSync`) —
 * mirroring the `process.std*.write` recognition rather than the `node:fs`
 * import recognition. Under `--target wasi` these lower DIRECTLY to
 * `wasi_snapshot_preview1.fd_read` / `fd_write`, reusing #2655's
 * `ctx.wasiFdReadIdx` / `wasiFdWriteIdx` (no duplicate import) and the
 * iovec/scratch machinery shared with `node-fs-api.ts`. The result: the SAME
 * `nm_js2wasm_deno.ts` source compiles to a self-contained WASI P1 command module
 * importing ONLY `wasi_snapshot_preview1`, AND runs unmodified under real Deno.
 *
 * The one intricate part is `readSync`'s `number | null` return. The compiler
 * already represents a `number | null` value-type as an `externref` carrying
 * either a WasmGC-NATIVE boxed-number struct or `ref.null extern` — so `=== null`
 * lowers to `ref.is_null` and arithmetic to the native `__unbox_number` helper,
 * with NO `env::*` host import (`__box_number` resolves to a native helper under
 * `ctx.wasi`). We reproduce exactly that representation:
 *   count > 0 ? __box_number(f64(count)) : ref.null extern.
 * A 0-byte read (EOF) faithfully yields `null`.
 *
 * Byte-neutral for any program that does not reference `Deno.` — the shape match
 * fails immediately, so nothing is emitted differently.
 */
import type { Instr, ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import {
  emitArrayToScratchCopy,
  emitFdReadRuntime,
  emitFdWriteRuntime,
  emitNodeFsResolveGcU8,
  emitScratchToArrayCopy,
  ensureScratchPages,
} from "./node-fs-api.js";
import { WASI_STDIN_BUF_START, WASI_WRITE_SCRATCH_START } from "./index.js";
import { getLinearU8Buffer } from "./linear-uint8-codegen.js";
import type { InnerResult } from "./shared.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";

type DenoStdioMatch = { kind: "read" } | { kind: "write"; fd: 1 | 2 };

/**
 * Recognize an unshadowed ambient `Deno.stdin.readSync(buf)` /
 * `Deno.{stdout,stderr}.writeSync(buf)` call. Returns the matched form, or null
 * when this isn't a Deno stdio call we handle. A local/captured `Deno` shadow is
 * left alone (so a user `const Deno = …` keeps its own semantics).
 */
function matchDenoStdio(fctx: FunctionContext, expr: ts.CallExpression): DenoStdioMatch | null {
  if (expr.questionDotToken || expr.arguments.length !== 1) return null;
  const methodAccess = expr.expression;
  if (!ts.isPropertyAccessExpression(methodAccess)) return null;
  const method = methodAccess.name.text;
  if (method !== "readSync" && method !== "writeSync") return null;
  const streamAccess = methodAccess.expression;
  if (!ts.isPropertyAccessExpression(streamAccess)) return null;
  const stream = streamAccess.name.text;
  // `Deno` must be the unshadowed ambient global.
  const root = streamAccess.expression;
  if (!ts.isIdentifier(root) || root.text !== "Deno") return null;
  if (fctx.localMap.has("Deno") || (fctx.boxedCaptures?.has("Deno") ?? false)) return null;

  if (method === "readSync" && stream === "stdin") return { kind: "read" };
  if (method === "writeSync" && stream === "stdout") return { kind: "write", fd: 1 };
  if (method === "writeSync" && stream === "stderr") return { kind: "write", fd: 2 };
  return null;
}

/**
 * Recognize + lower a Deno synchronous stdio call under `--target wasi`. Returns
 * the result (`number | null` externref for readSync, `number` f64 for
 * writeSync), or `undefined` when this isn't a Deno stdio call (the generic
 * compiler then proceeds). Non-WASI targets fall through entirely — a Deno
 * program "runs under real Deno" uncompiled; we only LOWER it under wasi.
 */
export function tryCompileDenoStdioCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | undefined {
  if (!ctx.wasi) return undefined;
  const match = matchDenoStdio(fctx, expr);
  if (!match) return undefined;

  if (match.kind === "read") {
    const syscallIdx = ctx.wasiFdReadIdx;
    // Registered up-front in registerWasiImports when Deno.stdin.readSync is
    // detected. Defensive: bail to the generic path if it somehow wasn't.
    if (syscallIdx === undefined || syscallIdx < 0) return undefined;
    return emitDenoReadSync(ctx, fctx, expr.arguments[0]!, syscallIdx);
  }

  const syscallIdx = ctx.wasiFdWriteIdx;
  if (syscallIdx === undefined || syscallIdx < 0) return undefined;
  return emitDenoWriteSync(ctx, fctx, expr.arguments[0]!, match.fd, syscallIdx);
}

/**
 * `Deno.stdin.readSync(buf)` → `fd_read(0, …)` into the WHOLE of `buf`, returning
 * `number | null` (bytes read, or `null` at EOF). Linear-backed Uint8Array reads
 * straight into `ptr` (zero-copy); a GC Uint8Array reads into the shared stdin
 * scratch, then copies the bytes into the array. The byte count is then boxed to
 * the native `number | null` representation (`__box_number` / `ref.null extern`).
 */
function emitDenoReadSync(
  ctx: CodegenContext,
  fctx: FunctionContext,
  bufExpr: ts.Expression,
  syscallIdx: number,
): InnerResult {
  // Pull in the NATIVE __box_number helper FIRST (before emitting any fd
  // instructions), so the post-fd `call $__box_number` baked below uses a stable
  // func index. Under `ctx.wasi` this routes to addUnionImportsViaRegistry (a
  // native defined helper — no env:: host import), which performs its own index
  // shift; flushLateImportShifts settles any pending deferred shift too.
  const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);

  // fd 0 in a fresh i32 local (emitFdReadRuntime reads the fd from a local).
  const fdLocal = allocLocal(fctx, `__deno_fd_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: fdLocal });

  const nreadLocal = allocLocal(fctx, `__deno_nread_${fctx.locals.length}`, { kind: "i32" });

  // Zero-copy fast path: linear-backed Uint8Array reads straight into ptr for
  // buf.length bytes (Deno fills the WHOLE buffer — no offset/length options).
  const linBuf = getLinearU8Buffer(ctx, fctx, bufExpr);
  if (linBuf) {
    emitFdReadRuntime(fctx, fdLocal, linBuf.ptrLocalIdx, linBuf.lenLocalIdx, syscallIdx, true);
    fctx.body.push({ op: "local.set", index: nreadLocal });
    return emitBoxCountOrNull(fctx, nreadLocal, boxIdx);
  }

  const gc = emitNodeFsResolveGcU8(ctx, fctx, bufExpr);
  if (!gc) {
    // Unrecognizable buffer — report EOF (null) so codegen continues.
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  // Read up to buf.length bytes into the shared stdin scratch, then copy into
  // the GC array at offset 0.
  ensureScratchPages(fctx, WASI_STDIN_BUF_START, gc.lenLocal);
  const scratchPtrLocal = allocLocal(fctx, `__deno_rscratch_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: WASI_STDIN_BUF_START });
  fctx.body.push({ op: "local.set", index: scratchPtrLocal });
  emitFdReadRuntime(fctx, fdLocal, scratchPtrLocal, gc.lenLocal, syscallIdx, true);
  fctx.body.push({ op: "local.set", index: nreadLocal });

  const offZeroLocal = emitZeroLocal(fctx);
  emitScratchToArrayCopy(fctx, gc.arrTypeIdx, gc.arrLocal, offZeroLocal, WASI_STDIN_BUF_START, nreadLocal);

  return emitBoxCountOrNull(fctx, nreadLocal, boxIdx);
}

/**
 * `Deno.{stdout,stderr}.writeSync(buf)` → `fd_write(fd, …)` of the WHOLE of
 * `buf`, returning `number` (bytes written). Linear-backed Uint8Array writes
 * straight from `ptr` (zero-copy); a GC Uint8Array stages into the write scratch
 * first. The easy direction — identical to node:fs `writeSync(fd, buf)` minus the
 * offset/length options (Deno writes the entire buffer).
 */
function emitDenoWriteSync(
  ctx: CodegenContext,
  fctx: FunctionContext,
  bufExpr: ts.Expression,
  fd: 1 | 2,
  syscallIdx: number,
): InnerResult {
  const fdLocal = allocLocal(fctx, `__deno_fd_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: fd });
  fctx.body.push({ op: "local.set", index: fdLocal });

  const linBuf = getLinearU8Buffer(ctx, fctx, bufExpr);
  if (linBuf) {
    emitFdWriteRuntime(ctx, fctx, fdLocal, linBuf.ptrLocalIdx, linBuf.lenLocalIdx, syscallIdx, true);
    fctx.body.push({ op: "f64.convert_i32_s" });
    return { kind: "f64" };
  }

  const gc = emitNodeFsResolveGcU8(ctx, fctx, bufExpr);
  if (!gc) {
    fctx.body.push({ op: "f64.const", value: 0 });
    return { kind: "f64" };
  }

  ensureScratchPages(fctx, WASI_WRITE_SCRATCH_START, gc.lenLocal);
  const offZeroLocal = emitZeroLocal(fctx);
  emitArrayToScratchCopy(fctx, gc.arrTypeIdx, gc.arrLocal, offZeroLocal, WASI_WRITE_SCRATCH_START, gc.lenLocal);

  const scratchPtrLocal = allocLocal(fctx, `__deno_wscratch_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: WASI_WRITE_SCRATCH_START });
  fctx.body.push({ op: "local.set", index: scratchPtrLocal });
  emitFdWriteRuntime(ctx, fctx, fdLocal, scratchPtrLocal, gc.lenLocal, syscallIdx, true);
  fctx.body.push({ op: "f64.convert_i32_s" });
  return { kind: "f64" };
}

/** Alloc a fresh i32 local set to 0 (the offset for a whole-buffer read/write). */
function emitZeroLocal(fctx: FunctionContext): number {
  const z = allocLocal(fctx, `__deno_off0_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: z });
  return z;
}

/**
 * Emit `nread > 0 ? __box_number(f64(nread)) : ref.null extern` leaving an
 * `externref` on the stack — the compiler's NATIVE representation of a
 * `number | null` value. A 0-byte read (EOF) yields `null`. `boxIdx` is the
 * native `__box_number` func index resolved up-front.
 */
function emitBoxCountOrNull(fctx: FunctionContext, nreadLocal: number, boxIdx: number | undefined): InnerResult {
  fctx.body.push({ op: "local.get", index: nreadLocal });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.gt_s" });
  const externType: ValType = { kind: "externref" };
  const thenArm: Instr[] =
    boxIdx !== undefined && boxIdx >= 0
      ? [{ op: "local.get", index: nreadLocal }, { op: "f64.convert_i32_s" }, { op: "call", funcIdx: boxIdx }]
      : // Native box unavailable (defensive) — fall back to null so the module
        // still validates (never expected under --target wasi).
        [{ op: "ref.null.extern" }];
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: externType },
    then: thenArm,
    else: [{ op: "ref.null.extern" }],
  });
  return { kind: "externref" };
}
