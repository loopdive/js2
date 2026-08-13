// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Local-slot allocation helpers.
 *
 * This module owns parameter/local slot bookkeeping and temporary-local reuse.
 */
import type { Instr, ValType } from "../../ir/types.js";
import { walkChildren } from "../walk-instructions.js";
import type { FunctionContext } from "./types.js";

export function allocLocal(fctx: FunctionContext, name: string, type: ValType): number {
  const index = fctx.params.length + fctx.locals.length;
  fctx.locals.push({ name, type });
  fctx.localMap.set(name, index);
  return index;
}

/**
 * #1847 — snapshot of the local-allocation state, for tentative compilation
 * that may be rolled back. Captures the locals-vector length so callers can
 * truncate, plus the `localMap` names present at snapshot time so we can drop
 * any name `allocLocal` added afterwards (whose slot the truncation removes).
 *
 * Tentative-compile sites previously truncated `fctx.locals.length` (and
 * `fctx.body.length`) but left `fctx.localMap` pointing at slots past the
 * truncated vector — an unbalanced state. Snapshot/restore keeps the three in
 * sync.
 */
export interface LocalsSnapshot {
  readonly localsLen: number;
  /**
   * Full `localMap` entries (name → slot index) at snapshot time. Restoring the
   * complete map — not just the key SET — is required because a speculative
   * compile may **re-point an EXISTING name** to a freshly-allocated slot, not
   * only add new names: closure-capture boxing
   * (`fctx.localMap.set(cap.name, boxedLocalIdx)` in closures.ts) re-aims an
   * outer variable at its boxed ref-cell. A key-set-only snapshot can delete the
   * newly-added box slot but leaves the outer name pointing at the (now
   * truncated) box index, so a post-rollback read of that variable emits a
   * `local.get` past the function's local count — `local index out of range`
   * at emit time. #2029 (tagged-template tag = a closure capturing an outer
   * local; the tagged-template probe boxed `calls`→slot N, rolled back, and
   * `return calls` then read the stale slot N).
   */
  readonly mapEntries: ReadonlyArray<readonly [string, number]>;
  /** Exact `boxedCaptures` metadata at snapshot time. A speculative promotion
   * can replace an existing entry's cell type, so preserving names alone is
   * insufficient even when the corresponding localMap entry is restored. */
  readonly boxedEntries: ReadonlyArray<readonly [string, { refCellTypeIdx: number; valType: ValType }]> | null;
  /**
   * (#3032) Exact `boxedTdzFlags` / `tdzFlagLocals` entries at snapshot time
   * (`null` when the map was absent). The call-site TDZ-flag prepend
   * (call-identifier.ts #1205 Stage 3 fresh-box arm) allocates a
   * `__tdz_box_<name>` local and RE-AIMS both maps at it — the exact same
   * mutation class as the closure-capture boxing above, but on the TDZ maps,
   * which the pre-#3032 snapshot did not cover. A rolled-back probe then left
   * both maps pointing at a truncated slot, and the committed re-compile's
   * `existing` branch baked `local.get <stale slot>` — a slot later re-allocated
   * at a DIFFERENT type (invalid wasm: `call[k] expected (ref null $cell)`;
   * surfaced by a for-of over a TDZ-flagged-capture nested generator call).
   */
  readonly tdzBoxEntries: ReadonlyArray<readonly [string, { refCellTypeIdx: number; localIdx: number }]> | null;
  readonly tdzFlagEntries: ReadonlyArray<readonly [string, number]> | null;
  /** Stable direct-eval activation cells must roll back with their locals. */
  readonly directEvalActivationEntries: ReadonlyArray<readonly [string, number]> | null;
  /** Hidden direct-eval state-pool local allocated by a speculative route. */
  readonly directEvalStatePoolLocal: number | null;
}

export function snapshotLocals(fctx: FunctionContext): LocalsSnapshot {
  return {
    localsLen: fctx.locals.length,
    mapEntries: Array.from(fctx.localMap.entries()),
    boxedEntries: fctx.boxedCaptures
      ? Array.from(fctx.boxedCaptures.entries(), ([name, entry]) => [name, { ...entry }] as const)
      : null,
    tdzBoxEntries: fctx.boxedTdzFlags ? Array.from(fctx.boxedTdzFlags.entries()) : null,
    tdzFlagEntries: fctx.tdzFlagLocals ? Array.from(fctx.tdzFlagLocals.entries()) : null,
    directEvalActivationEntries: fctx.directEvalActivationBindings
      ? Array.from(fctx.directEvalActivationBindings.entries())
      : null,
    directEvalStatePoolLocal: fctx.directEvalActivationStatePoolLocal ?? null,
  };
}

/**
 * #1847 — undo allocations made since `snap`: truncate the locals vector and
 * restore `localMap` to its EXACT snapshot state (drop added names AND reset
 * re-pointed existing names to their snapshot slot — see {@link LocalsSnapshot}
 * `mapEntries` for why the value, not just the key, must be restored). Does NOT
 * touch `fctx.body` — callers truncate that themselves (the body length to
 * roll back to is site-specific and often captured separately).
 *
 * `tempFreeList` is left as-is on purpose: it only ever holds indices that were
 * valid at allocation time, and the temp-local reuse path keys buckets by type;
 * a rolled-back tentative compile that released a temp would have pushed a slot
 * index that is now beyond `locals.length`. To keep the free-list from handing
 * out a truncated slot, we prune any bucket entry that points past the new
 * locals length.
 */
export function restoreLocals(fctx: FunctionContext, snap: LocalsSnapshot): void {
  if (fctx.locals.length > snap.localsLen) {
    fctx.locals.length = snap.localsLen;
  }
  // Restore `localMap` to its exact snapshot state: clear and re-insert every
  // snapshot entry. This both drops names the probe ADDED and resets names the
  // probe RE-POINTED (e.g. closure-capture boxing) to their original slot.
  fctx.localMap.clear();
  for (const [name, idx] of snap.mapEntries) {
    fctx.localMap.set(name, idx);
  }
  // Restore the complete capture metadata. A probe may not only ADD a box; it
  // may promote an existing narrow cell to the canonical eval cell while also
  // re-pointing localMap. Restoring only the name set leaves metadata claiming
  // the old raw local is a new cell, producing an illegal cast on the next read.
  if (snap.boxedEntries === null) {
    fctx.boxedCaptures = undefined;
  } else {
    if (!fctx.boxedCaptures) fctx.boxedCaptures = new Map();
    fctx.boxedCaptures.clear();
    for (const [name, entry] of snap.boxedEntries) {
      fctx.boxedCaptures.set(name, { ...entry });
    }
  }
  // (#3032) Restore `boxedTdzFlags` / `tdzFlagLocals` to their EXACT snapshot
  // state — the call-site TDZ-flag prepend both ADDS entries and RE-AIMS
  // existing ones (`tdzFlagLocals` from the raw i32 flag local to the fresh
  // box local), so like `localMap` above the full entry set must be restored,
  // not just added keys dropped. A leaked re-aim leaves the map pointing at a
  // truncated slot that a later alloc re-uses at a different type.
  if (fctx.boxedTdzFlags || snap.tdzBoxEntries) {
    if (snap.tdzBoxEntries === null) {
      fctx.boxedTdzFlags = undefined;
    } else {
      if (!fctx.boxedTdzFlags) fctx.boxedTdzFlags = new Map();
      fctx.boxedTdzFlags.clear();
      for (const [name, entry] of snap.tdzBoxEntries) fctx.boxedTdzFlags.set(name, entry);
    }
  }
  if (fctx.tdzFlagLocals || snap.tdzFlagEntries) {
    if (snap.tdzFlagEntries === null) {
      fctx.tdzFlagLocals = undefined;
    } else {
      if (!fctx.tdzFlagLocals) fctx.tdzFlagLocals = new Map();
      fctx.tdzFlagLocals.clear();
      for (const [name, idx] of snap.tdzFlagEntries) fctx.tdzFlagLocals.set(name, idx);
    }
  }
  if (snap.directEvalActivationEntries === null) {
    fctx.directEvalActivationBindings = undefined;
  } else {
    if (!fctx.directEvalActivationBindings) fctx.directEvalActivationBindings = new Map();
    fctx.directEvalActivationBindings.clear();
    for (const [name, idx] of snap.directEvalActivationEntries) {
      fctx.directEvalActivationBindings.set(name, idx);
    }
  }
  fctx.directEvalActivationStatePoolLocal = snap.directEvalStatePoolLocal ?? undefined;
  // Prune any temp-free-list entries that now point past the truncated vector.
  if (fctx.tempFreeList) {
    const maxValid = fctx.params.length + snap.localsLen;
    for (const bucket of fctx.tempFreeList.values()) {
      for (let i = bucket.length - 1; i >= 0; i--) {
        if (bucket[i]! >= maxValid) bucket.splice(i, 1);
      }
    }
  }
}

function valTypeKey(type: ValType): string {
  switch (type.kind) {
    case "ref":
      return `ref:${type.typeIdx}`;
    case "ref_null":
      return `ref_null:${type.typeIdx}`;
    default:
      return type.kind;
  }
}

export function allocTempLocal(fctx: FunctionContext, type: ValType): number {
  if (!fctx.tempFreeList) fctx.tempFreeList = new Map();
  const key = valTypeKey(type);
  const bucket = fctx.tempFreeList.get(key);
  if (bucket && bucket.length > 0) {
    return bucket.pop()!;
  }
  return allocLocal(fctx, `__tmp_${fctx.locals.length}`, type);
}

export function releaseTempLocal(fctx: FunctionContext, index: number): void {
  const type = getLocalType(fctx, index);
  if (!type) return;
  if (!fctx.tempFreeList) fctx.tempFreeList = new Map();
  const key = valTypeKey(type);
  let bucket = fctx.tempFreeList.get(key);
  if (!bucket) {
    bucket = [];
    fctx.tempFreeList.set(key, bucket);
  }
  bucket.push(index);
}

export function getLocalType(fctx: FunctionContext, index: number): ValType | undefined {
  if (index < fctx.params.length) return fctx.params[index]!.type;
  const localIdx = index - fctx.params.length;
  return fctx.locals[localIdx]?.type;
}

/**
 * Post-processing pass: eliminate duplicate local declarations.
 *
 * When the same variable name appears more than once in fctx.locals (due to
 * sibling block scopes, try/catch blocks, or for-loops with the same counter
 * name), this merges the duplicates by:
 * 1. Keeping the first occurrence of each name (lowest index)
 * 2. Rewriting all local.get/set/tee instructions that reference duplicate
 *    slots to use the canonical (first) slot instead
 * 3. Compacting fctx.locals to remove the now-unreferenced duplicate entries
 *
 * This handles ALL remaining duplicate local patterns uniformly, regardless
 * of how they were generated (sibling for-loops, try/catch, for-of, etc.).
 */
export function deduplicateLocals(fctx: FunctionContext): void {
  const paramCount = fctx.params.length;
  const n = fctx.locals.length;
  if (n === 0) return;

  // First pass: find which relative indices are duplicates.
  // Only merge locals that share both the same name AND the same type —
  // same-name locals with different types are not interchangeable (#962).
  // IMPORTANT: Only dedup compiler-generated temps (names starting with "__").
  // User-visible variables with the same name in different block scopes must
  // NOT be merged — nested scopes can shadow outer variables, and merging
  // would corrupt the outer variable's value (e.g., IIFE param `x` + `let x`).
  const nameToFirstRel = new Map<string, number>();
  const isDuplicate = new Uint8Array(n); // 0 = keep, 1 = duplicate

  for (let i = 0; i < n; i++) {
    const local = fctx.locals[i]!;
    // Skip user-visible variables — only dedup compiler temps
    if (!local.name.startsWith("__")) continue;
    const key = local.name + "\0" + valTypeKey(local.type);
    if (nameToFirstRel.has(key)) {
      isDuplicate[i] = 1;
    } else {
      nameToFirstRel.set(key, i);
    }
  }

  if (!isDuplicate.some(Boolean)) return; // nothing to deduplicate

  // Second pass: compute new absolute index for each old relative index.
  // Kept locals are compacted (earlier duplicates shift indices down).
  // Duplicate locals map to the new absolute index of their canonical slot.
  const relToNewAbs = new Int32Array(n).fill(-1);
  let kept = 0;
  for (let i = 0; i < n; i++) {
    if (!isDuplicate[i]) {
      relToNewAbs[i] = paramCount + kept;
      kept++;
    }
  }

  // Build index remap: old absolute → new absolute (omit identity mappings)
  const indexRemap = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const absOld = paramCount + i;
    let absNew: number;
    if (isDuplicate[i]) {
      const local = fctx.locals[i]!;
      const firstRel = nameToFirstRel.get(local.name + "\0" + valTypeKey(local.type))!;
      absNew = relToNewAbs[firstRel]; // canonical slot's new absolute index
    } else {
      absNew = relToNewAbs[i];
    }
    if (absOld !== absNew) indexRemap.set(absOld, absNew);
  }

  if (indexRemap.size > 0) {
    rewriteLocalRefs(fctx.body, indexRemap);
  }

  // Compact locals array: remove duplicate entries
  fctx.locals = fctx.locals.filter((_, i) => !isDuplicate[i]);
}

function rewriteLocalRefs(
  instrs: Instr[],
  indexRemap: Map<number, number>,
  seen: WeakSet<object> = new WeakSet<object>(),
): void {
  for (const instr of instrs) {
    // Instruction fragments are sometimes intentionally shared between two
    // control-flow arms (for example Array#join's element conversion). A local
    // compaction remap is not idempotent: visiting the same object through both
    // arms applies old→new twice and can redirect it to an unrelated local.
    if (seen.has(instr)) continue;
    seen.add(instr);
    const op = instr.op;
    if (op === "local.get" || op === "local.set" || op === "local.tee") {
      const newIdx = indexRemap.get((instr as { index: number }).index);
      if (newIdx !== undefined) (instr as { index: number }).index = newIdx;
    }
    walkChildren(instr, (body) => rewriteLocalRefs(body, indexRemap, seen));
  }
}
