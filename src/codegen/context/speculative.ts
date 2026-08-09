// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1919 — transactional speculative compilation.
 *
 * The "probe-compile-and-rollback" idiom — speculatively `compileExpression`,
 * inspect the produced ValType, then truncate `fctx.body.length` to undo —
 * appears at ~20 call sites across the backend. Truncating only `fctx.body`
 * restores the emitted instructions but leaks every OTHER mutation the probe
 * made: locals allocated during the probe (#1847 began fixing this with
 * `snapshotLocals`/`restoreLocals`, but only `loops.ts` adopted it), late
 * imports registered via `ensureLateImport`, and error diagnostics pushed onto
 * `ctx.errors`.
 *
 * A leaked late import is the worst of these: `ensureLateImport` appends to
 * `ctx.mod.imports`, bumps `ctx.numImportFuncs`, writes `ctx.funcMap`, and arms
 * `ctx.pendingLateImportShift`. A probe that registers an import then rolls back
 * the body leaves a PHANTOM import in the module — and the next real
 * `flushLateImportShifts` shifts every already-emitted function index by the
 * phantom count, a module-wide heisenbug (the #1919 / #1916 interaction).
 *
 * This module captures a transactional snapshot of all that mutable state and
 * provides an exact unwind. The snapshot is cheap (a few integers plus a Set of
 * the funcMap names present at snapshot time) so probes stay fast.
 *
 * Invariant the unwind relies on: a speculative region NEVER flushes a late
 * import shift (`flushLateImportShifts`). A probe always rolls back, so flushing
 * mid-probe would corrupt the very bodies the probe is about to discard —
 * well-behaved probes register-but-defer, exactly the deferred-shift design of
 * `ensureLateImport`. The snapshot records `pendingLateImportShift` and restores
 * it on rollback, so a probe that armed the pending shift (without flushing) is
 * fully undone.
 */
import type { CodegenContext, FunctionContext } from "./types.js";
import { type LocalsSnapshot, snapshotLocals, restoreLocals } from "./locals.js";

/**
 * A transactional snapshot of the codegen state a speculative compile can
 * mutate. Capture with {@link snapshotSpeculative}; undo with
 * {@link rollbackSpeculative}. Discard (no-op) to commit.
 *
 * The snapshot is near-O(1): every field is an integer read or a reference copy
 * (`snapshotLocals` copies the localMap ENTRIES — name→slot — so a re-pointed
 * existing name can be restored, not just dropped; locals are typically tiny;
 * crucially the funcMap is NOT copied — rollback derives the names to delete
 * from the popped import descriptors, which each carry their `name`). This keeps
 * the helper cheap enough to wrap even the hot `compileExpression` path.
 */
export interface SpeculativeSnapshot {
  /** `fctx.body.length` at snapshot time — the rollback truncation target. */
  readonly bodyLen: number;
  /** Locals / localMap / temp-free-list snapshot (#1847). */
  readonly locals: LocalsSnapshot;
  /** `ctx.errors.length` — diagnostics pushed during the probe are discarded. */
  readonly errorsLen: number;
  /** `ctx.mod.imports.length` — imports appended during the probe are popped. */
  readonly importsLen: number;
  /** `ctx.numImportFuncs` — restored so the func index space is rewound. */
  readonly numImportFuncs: number;
  /** `ctx.numImportGlobals` — restored if the probe added an import global. */
  readonly numImportGlobals: number;
  /**
   * `ctx.pendingLateImportShift` reference at snapshot time. A probe that armed
   * the deferred shift (called `ensureLateImport` while `pendingLateImportShift`
   * was null) is rewound by restoring this exact reference (usually `null`).
   */
  readonly pendingLateImportShift: CodegenContext["pendingLateImportShift"];
  /** `mod.types.length` — see {@link rollbackSpeculative} for why this is advisory. */
  readonly typesLen: number;
}

/**
 * Capture a transactional snapshot of all state a speculative compile may
 * mutate. O(localMap.size) for the locals key-set copy; everything else is a
 * handful of integer / reference reads (no funcMap copy — see
 * {@link rollbackSpeculative}).
 */
export function snapshotSpeculative(ctx: CodegenContext, fctx: FunctionContext): SpeculativeSnapshot {
  return {
    bodyLen: fctx.body.length,
    locals: snapshotLocals(fctx),
    errorsLen: ctx.errors.length,
    importsLen: ctx.mod.imports.length,
    numImportFuncs: ctx.numImportFuncs,
    numImportGlobals: ctx.numImportGlobals,
    pendingLateImportShift: ctx.pendingLateImportShift,
    typesLen: ctx.mod.types.length,
  };
}

/**
 * Undo every mutation made since {@link snapshotSpeculative} produced `snap`.
 *
 * - Truncate `fctx.body` to the snapshot length (the classic rollback).
 * - Restore locals / localMap / temp-free-list (#1847 `restoreLocals`).
 * - Drop diagnostics pushed during the probe (`ctx.errors`).
 * - Pop late imports registered during the probe off `ctx.mod.imports`, rewind
 *   `numImportFuncs` / `numImportGlobals`, delete their `funcMap` entries, and
 *   restore the deferred-shift latch. This is the leak the #1919 helper exists
 *   to close: because the probe never flushed the shift (the documented
 *   invariant), the appended imports never shifted any already-emitted index, so
 *   popping them and resetting the counters returns the import space exactly to
 *   the pre-probe state with no body re-walk required.
 *
 * Registered Wasm TYPES (`ctx.mod.types` / `funcTypeCache` / struct maps) are
 * deliberately NOT truncated. Type registration is content-addressed and
 * idempotent (`addFuncType` dedups by signature; `getOrRegisterVecType` &c. cache
 * by element kind), and type indices — unlike function indices — are never
 * shifted by later import additions. A type registered during a rolled-back
 * probe is therefore inert: it is either reused verbatim by the committed
 * re-compile or pruned by dead-type elimination if truly unreferenced. Truncating
 * it would risk desyncing a struct type registered earlier and still referenced
 * (see `project_type_index_shift_and_deadelim`). `typesLen` is kept on the
 * snapshot only for diagnostics / a future tightening, not acted on here.
 */
export function rollbackSpeculative(ctx: CodegenContext, fctx: FunctionContext, snap: SpeculativeSnapshot): void {
  // 1. Body — the original rollback.
  if (fctx.body.length > snap.bodyLen) {
    fctx.body.length = snap.bodyLen;
  }
  // 2. Locals (#1847).
  restoreLocals(fctx, snap.locals);
  // 3. Diagnostics pushed during the probe — EXCEPT the ones marked `sticky`.
  //    (#3725) A probe's diagnostic describes emission this unwind just erased,
  //    so dropping it is right. A `sticky` diagnostic is not a probe result: it
  //    is a deliberate refusal ("this program cannot be compiled for this
  //    target"), which no fallback value can repair. Discarding those turned the
  //    #1599 standalone-JSON refusal into a module that compiled clean and
  //    trapped at runtime. See `CodegenError.sticky`.
  if (ctx.errors.length > snap.errorsLen) {
    const sticky = ctx.errors.slice(snap.errorsLen).filter((e) => e.sticky === true);
    ctx.errors.length = snap.errorsLen;
    if (sticky.length > 0) ctx.errors.push(...sticky);
  }
  // 4. Late FUNC imports registered during the probe. Pop them, rewind
  //    `numImportFuncs`, drop their funcMap names, and restore the deferred-shift
  //    latch. Guard on growth so a probe that added nothing (the common case) is
  //    a pure no-op.
  //
  //    The funcMap names to delete are read straight off the popped descriptors:
  //    `ensureLateImport` only reaches `addImport` (the only appender) AFTER a
  //    `funcMap.get(name) !== undefined` early-return, so every func import
  //    appended during the probe carries a NAME that was absent from funcMap at
  //    snapshot time. Deleting exactly those names restores funcMap precisely.
  //
  //    Import GLOBALS (JS-host string constants registered via
  //    `addStringConstantGlobal`) are deliberately NOT popped. They are
  //    content-addressed and idempotent (`stringGlobalMap.has(value)` early-
  //    returns), so a constant registered during a rolled-back probe is reused
  //    verbatim by the committed re-compile or stays an inert unused global.
  //    Crucially, registering an import global runs `fixupModuleGlobalIndices`,
  //    which already SHIFTED every `global.get` in already-committed bodies; the
  //    naive `numImportGlobals--` here would NOT un-shift those, leaving them
  //    out of range ("global index out of range"). Func-import indices are
  //    positional among funcs and independent of where globals sit in
  //    `ctx.mod.imports`, so removing only the func entries (keeping the global
  //    entries, hence the global shift, intact) is index-correct for both spaces.
  //
  //    SAFETY — only pop when the probe's func imports are still UNFLUSHED.
  //    `ensureLateImport` defers the index shift (arms `pendingLateImportShift`)
  //    so a probe that merely registered imports left committed func bodies
  //    untouched — popping is exact. But some emit helpers `flushLateImportShifts`
  //    eagerly; if the probe flushed, every committed func index was already
  //    shifted UP by the probe's imports and there is no cheap inverse (the
  //    shift walker is forward-only). A flush is detectable: it consumes the
  //    pending batch, so `pendingLateImportShift === null` while func imports
  //    were added. In that rare case we KEEP the imports registered — exactly the
  //    pre-#1919 behaviour (consistent, just a phantom import), never corrupting
  //    indices. The common no-flush probe still cleans up fully.
  if (ctx.mod.imports.length > snap.importsLen) {
    const addedFuncImports = ctx.numImportFuncs > snap.numImportFuncs;
    const probeFlushed = addedFuncImports && ctx.pendingLateImportShift === null;
    if (!probeFlushed) {
      const kept = ctx.mod.imports.slice(0, snap.importsLen);
      for (let i = snap.importsLen; i < ctx.mod.imports.length; i++) {
        const imp = ctx.mod.imports[i]!;
        if (imp.desc.kind === "func") {
          // Probe func imports all carry the highest func indices (registered in
          // order at/above snap.numImportFuncs), so removing the whole run leaves
          // every committed func index unchanged.
          ctx.funcMap.delete(imp.name);
        } else {
          // Preserve import globals (and any non-func import) — see above.
          kept.push(imp);
        }
      }
      ctx.mod.imports = kept;
      ctx.numImportFuncs = snap.numImportFuncs;
      // `numImportGlobals` is intentionally left as-is: kept globals retain their
      // indices and the shift they triggered stays consistent.
      // Restore the deferred-shift latch. If the probe armed it (snapshot was
      // null, probe set it), this returns it to null so the next real
      // flushLateImportShifts computes its delta from a clean base.
      ctx.pendingLateImportShift = snap.pendingLateImportShift;
    }
  }
}

/**
 * Run `fn` as a speculative compile. `fn` returns a result and decides whether
 * to keep ({@link SpeculativeOutcome.commit} `true`) or discard the emitted
 * state. On `commit: false` (or if `fn` throws) the entire transaction is rolled
 * back via {@link rollbackSpeculative} and `value` is still returned to the
 * caller (so a probe can inspect the produced type after rollback).
 *
 * Use this for "try to lower; keep the body iff the shape matched" sites. For
 * the pure "what ValType does this compile to, then always discard" probe use
 * {@link probeCompiledType}, which is a thin wrapper that always rolls back.
 */
export interface SpeculativeOutcome<T> {
  commit: boolean;
  value: T;
}

export function withSpeculativeCompile<T>(
  ctx: CodegenContext,
  fctx: FunctionContext,
  fn: () => SpeculativeOutcome<T>,
): T {
  const snap = snapshotSpeculative(ctx, fctx);
  let outcome: SpeculativeOutcome<T>;
  try {
    outcome = fn();
  } catch (e) {
    rollbackSpeculative(ctx, fctx, snap);
    throw e;
  }
  if (!outcome.commit) {
    rollbackSpeculative(ctx, fctx, snap);
  }
  return outcome.value;
}

/**
 * The dominant probe shape: compile `fn` purely to learn the ValType it
 * produces, then ALWAYS roll back every side effect (body, locals, imports,
 * errors). Returns whatever `fn` returns (typically the probed `ValType | null`).
 *
 * This replaces the raw `const savedLen = fctx.body.length; … ;
 * fctx.body.length = savedLen;` idiom — which restored only the body — with a
 * full transactional rollback.
 */
export function probeCompiledType<T>(ctx: CodegenContext, fctx: FunctionContext, fn: () => T): T {
  const snap = snapshotSpeculative(ctx, fctx);
  try {
    return fn();
  } finally {
    rollbackSpeculative(ctx, fctx, snap);
  }
}
