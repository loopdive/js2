// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// ---------------------------------------------------------------------------
// func-space — the ONLY sanctioned way to read a function definition / import
// signature from an absolute function index mid-compile (#1916 S2 / #2710
// slice 3).
//
// WHY A CHOKEPOINT
// ----------------
// A `FuncHandle` (src/ir/types.ts) is today numerically equal to the live
// function-index-space position, and after the #1916 S3 flip it becomes a
// stable, never-renumbered id that only `resolveLayout()` (src/emit/
// resolve-layout.ts) may turn into a position. Any inline positional
// arithmetic on a handle — `mod.functions[h - numImportFuncs]`,
// `h < numImportFuncs` — bakes the "handle == live position" assumption into
// a call site, which is exactly the assumption S3 deletes. Concentrating that
// arithmetic here means the flip rewrites THESE functions to registry lookups
// and every caller is already correct.
//
// RULES
// -----
// - New code MUST NOT write `mod.functions[idx - numImportFuncs]` or compare
//   `idx < numImportFuncs` inline; call `definedFuncAt` / `isImportFuncIdx` /
//   `funcSignatureOf` instead.
// - Plain positional ITERATION over `mod.functions` (walking every function,
//   e.g. shifters/DCE/emit) is NOT this module's concern — that is layout
//   work, owned by the passes themselves until S3/S4 retire them.
// - These accessors are read-only lookups; they never mint indices. Minting
//   (`numImportFuncs + mod.functions.length`) stays at registration sites
//   until S3 replaces it with registry handle minting.
// ---------------------------------------------------------------------------

import type { FuncTypeDef, FuncHandle, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { STABLE_FUNC_BASE } from "../emit/resolve-layout.js";

/**
 * Position of a handle's function in `mod.functions`, or a negative number
 * when the handle denotes an import / a sentinel. Internal dual-regime core
 * (#1916 S3): stable handles resolve through `mod.funcOrdinalToPosition`;
 * live handles through the classic `h - numImportFuncs` arithmetic.
 */
function definedPositionOf(ctx: CodegenContext, funcIdx: FuncHandle): number {
  if (funcIdx >= STABLE_FUNC_BASE) {
    const pos = ctx.mod.funcOrdinalToPosition[funcIdx - STABLE_FUNC_BASE];
    // undefined = never minted; NaN = minted, not yet pushed. Both read as
    // "no defined record yet" (mirrors the pre-push live-regime behaviour
    // where the index points past the end of `mod.functions`).
    return pos === undefined || Number.isNaN(pos) ? -1 : pos;
  }
  return funcIdx - ctx.numImportFuncs;
}

/** True when the handle denotes an imported function (import index space). */
export function isImportFuncIdx(ctx: CodegenContext, funcIdx: FuncHandle): boolean {
  // Stable-regime handles (>= STABLE_FUNC_BASE) always denote DEFINED
  // functions — imports stay in the live regime (they are prefix-stable).
  return funcIdx < ctx.numImportFuncs;
}

/**
 * The defined-function record for an absolute function handle, or undefined
 * when the handle denotes an import (or is out of range / a sentinel like -1).
 * The returned object is the live `mod.functions` entry — callers that patch
 * helper bodies mutate through it exactly as before.
 */
export function definedFuncAt(ctx: CodegenContext, funcIdx: FuncHandle): WasmFunction | undefined {
  const pos = definedPositionOf(ctx, funcIdx);
  return pos >= 0 ? ctx.mod.functions[pos] : undefined;
}

/** Current handle for one exact allocator-owned defined-function object. */
export function definedFuncHandleOf(ctx: CodegenContext, func: WasmFunction): FuncHandle | undefined {
  const position = ctx.mod.functions.indexOf(func);
  if (position < 0) return undefined;
  const stableOrdinal = ctx.mod.funcOrdinalToPosition.indexOf(position);
  return stableOrdinal < 0 ? ctx.numImportFuncs + position : STABLE_FUNC_BASE + stableOrdinal;
}

/**
 * (#3909) Resolve a native-string runtime helper to a function handle,
 * STABLE-regime handle first.
 *
 * ## Why this exists
 *
 * Half a dozen call sites used to resolve these helpers with a positional scan
 * (`for i in mod.functions … return ctx.numImportFuncs + i`), each carrying a
 * comment saying `ctx.nativeStrHelpers` "captures funcIdx at registration time
 * and is not re-shifted by late-import passes". That was true before #1916 S3.
 * It is now inverted: every `nativeStrHelpers` entry is minted by
 * `mintDefinedFunc`, i.e. a STABLE handle (`>= STABLE_FUNC_BASE`) that no
 * shifter touches and that `resolveLayout` maps to a concrete index exactly
 * once, at emit, off the FINAL layout. The positional scan produces the
 * opposite: a LIVE index that is correct only until the next import lands, and
 * from then on depends on every shifter chasing it correctly.
 *
 * ## The failure that chase produces (#3909, and the reason this is unsound
 * rather than merely fragile)
 *
 * Shifters decide what to move with `inLiveShiftRange(idx, importsBefore)`,
 * i.e. `idx >= importsBefore`. A baked live index is a defined-function
 * reference, but it is just a number: once enough imports accumulate that
 * `importsBefore` climbs ABOVE that number, the guard reads the stale
 * reference as "an import index below the insertion point" and stops shifting
 * it. The reference is then permanently short by exactly the batches that
 * crossed it.
 *
 * Measured on the #3909 repro: `__str_trimStart`'s call to `__str_substring`
 * was baked as 61 with 54 imports; the 19 union/`typeof` imports that follow
 * push `importsBefore` past 61, one batch stops applying, and the call ends up
 * one slot low — landing on `__str_compare`, which takes 2 args instead of 3.
 * Wasm validation then rejects the helper with
 * "call[0] expected type (ref null 6), found i32.trunc_sat_f64_s of type i32".
 * This is exactly the ambiguity `src/emit/resolve-layout.ts` documents: "a
 * numeric index is ambiguous across shifts — any idx-keyed repair map is
 * unsound". It also explains the "only breaks with three features" signature —
 * you need enough imports for the count to cross the baked index.
 *
 * ## Contract
 *
 * Stable handle → return it (correct by construction, immune to every shift).
 * Otherwise → fall back to the historical positional scan, then to whatever the
 * map holds. So for any helper not yet on stable minting, behaviour is byte-for
 * byte what it was; for helpers that are, the fragile step is skipped entirely.
 */
export function nativeStrHelperHandle(ctx: CodegenContext, helperName: string): FuncHandle | undefined {
  const stable = ctx.nativeStrHelpers.get(helperName);
  if (stable !== undefined && stable >= STABLE_FUNC_BASE) return stable;
  for (let i = 0; i < ctx.mod.functions.length; i++) {
    if (ctx.mod.functions[i]!.name === helperName) return ctx.numImportFuncs + i;
  }
  return stable;
}

/**
 * Replace the defined-function record for an absolute function handle
 * (patch-in-place, e.g. the IR integration swapping a legacy-compiled body
 * for the IR-lowered one). The write-side twin of `definedFuncAt` — after the
 * S3 flip this maps handle→position through the registry, so positional
 * writes must flow through here too. Throws on a non-defined handle: every
 * caller is expected to have resolved the handle via `definedFuncAt` first.
 */
export function replaceDefinedFuncAt(ctx: CodegenContext, funcIdx: FuncHandle, fn: WasmFunction): void {
  const pos = definedPositionOf(ctx, funcIdx);
  if (pos < 0 || pos >= ctx.mod.functions.length) {
    throw new Error(`replaceDefinedFuncAt: funcIdx ${funcIdx} is not a defined function`);
  }
  traceSlotWrite(pos, "replaceDefinedFuncAt", fn);
  ctx.mod.functions[pos] = fn;
}

/**
 * (#4134) `JS2WASM_TRACE_SLOT=<position>` reports every write to one defined
 * function slot — the writer, the resulting frame size, and a stack — then keeps
 * going.
 *
 * A "local index out of range" at emit means a body and its frame disagree, and
 * the emitter can only say WHICH slot is inconsistent, never WHO made it so. On
 * an 8,000-function graph that is the difference between a targeted fix and
 * guesswork. Inert unless the variable is set.
 */
function traceSlotWrite(position: number, writer: string, fn: WasmFunction): void {
  if (typeof process === "undefined") return;
  const target = process.env?.JS2WASM_TRACE_SLOT;
  if (target === undefined || Number(target) !== position) return;
  const frame = fn.locals.length;
  process.stderr.write(
    `[js2:slot] ${writer} -> position ${position} name='${fn.name}' locals=${frame} ` +
      `bodyOps=${fn.body.length}\n${new Error("slot write").stack ?? ""}\n`,
  );
}

// ---------------------------------------------------------------------------
// #1916 S3 — stable-regime minting (the two-phase mint/push protocol).
//
// A producer that flips to the stable regime replaces
//     const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
//     ...build body...
//     ctx.mod.functions.push(fn);
// with
//     const funcIdx = mintDefinedFunc(ctx);
//     ...build body...
//     pushDefinedFunc(ctx, funcIdx, fn);
//
// The handle is layout-independent from the moment it is minted: it can be
// baked into call immediates, stored in funcMap/helper side-tables, and
// captured across arbitrary late-import churn — the shifters skip the stable
// range entirely, and resolution to a concrete index happens at emit
// (resolve-layout.ts). Mint and push may be separated by arbitrary nested
// emission (other producers pushing functions in between): the ordinal is
// decoupled from the position, which is recorded only at push time.
// ---------------------------------------------------------------------------

/**
 * Mint a stable defined-function handle. MUST be paired with exactly one
 * later `pushDefinedFunc` for the same handle; a minted-but-never-pushed
 * handle fails loudly at first resolution (`absoluteFuncIndex` throws).
 */
export function mintDefinedFunc(ctx: CodegenContext): FuncHandle {
  const ordinal = ctx.mod.funcOrdinalToPosition.length;
  // Reserve the ordinal slot now (NaN = minted, not yet pushed) so nested
  // mints get distinct ordinals even before this one's push happens.
  ctx.mod.funcOrdinalToPosition.push(Number.NaN);
  return STABLE_FUNC_BASE + ordinal;
}

/**
 * Push the function for a previously minted stable handle, recording its
 * position. Throws on a double-push or a non-stable handle.
 */
export function pushDefinedFunc(ctx: CodegenContext, funcIdx: FuncHandle, fn: WasmFunction): void {
  if (funcIdx < STABLE_FUNC_BASE) {
    throw new Error(`pushDefinedFunc: ${funcIdx} is not a stable-regime handle`);
  }
  const ordinal = funcIdx - STABLE_FUNC_BASE;
  const existing = ctx.mod.funcOrdinalToPosition[ordinal];
  if (existing === undefined) {
    throw new Error(`pushDefinedFunc: handle ${funcIdx} was never minted`);
  }
  if (!Number.isNaN(existing)) {
    throw new Error(`pushDefinedFunc: handle ${funcIdx} already pushed at position ${existing}`);
  }
  ctx.mod.funcOrdinalToPosition[ordinal] = ctx.mod.functions.length;
  traceSlotWrite(ctx.mod.functions.length, "pushDefinedFunc", fn);
  ctx.mod.functions.push(fn);
}

/**
 * The function signature (`FuncTypeDef`) for an absolute function handle,
 * covering BOTH index subspaces: imports (scanned in import-declaration
 * order, matching the function index space) and defined functions (via
 * `definedFuncAt`). Returns undefined when unresolvable.
 */
export function funcSignatureOf(ctx: CodegenContext, funcIdx: FuncHandle): FuncTypeDef | undefined {
  if (funcIdx < 0) return undefined;
  if (isImportFuncIdx(ctx, funcIdx)) {
    let importFuncCount = 0;
    for (const imp of ctx.mod.imports) {
      if (imp.desc.kind === "func") {
        if (importFuncCount === funcIdx) {
          const typeDef = ctx.mod.types[imp.desc.typeIdx];
          return typeDef?.kind === "func" ? typeDef : undefined;
        }
        importFuncCount++;
      }
    }
    return undefined;
  }
  const func = definedFuncAt(ctx, funcIdx);
  if (!func) return undefined;
  const typeDef = ctx.mod.types[func.typeIdx];
  return typeDef?.kind === "func" ? typeDef : undefined;
}
