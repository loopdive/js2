// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6480) Per-process memo for the lib-file extern-CLASS scan.
 *
 * On the `libIndex` (lib.*.d.ts) path the three declaration branches of
 * `collectExternDeclarations` that build extern classes — `declare namespace`,
 * `declare class`, and `declare var X: { new(): X }` — read nothing but the lib
 * syntax, the lib declaration index and three target-profile booleans, and write
 * nothing but `ctx.externClasses` / `ctx.externClassParent`. Those inputs are
 * identical for every compile in a process (the lib `SourceFile`s are cached by
 * `getLibSourceFile` in checker/index.ts), so the whole walk — measured at
 * ~19 ms per compile, dominated by `mapLibTypeNodeToWasm` — is replayed from a
 * recorded effect list instead of recomputed. For a pooled caller such as a
 * test262 worker (tens of thousands of compiles per lane) that is the entire
 * bucket.
 *
 * Correctness is carried by the KEY, not by trust. It pins:
 *
 *  - the lib source file, by OBJECT identity (`WeakMap`): `preloadLibFiles`
 *    drops the cached `SourceFile`s, so a replaced lib re-parses into a new
 *    object and misses here by construction — no invalidation hook needed;
 *  - the lib declaration index, by object identity (it is itself cached on the
 *    same file identities — see `buildLibDeclIndex`);
 *  - the three profile booleans the collectors read (`nativeStrings`,
 *    `standalone`, `wasi`) — e.g. `Map` is skipped as an extern class under
 *    native strings, and `RegExp.lastIndex` is retyped only in host mode;
 *  - a fingerprint of the two maps' PRE-state, because their content decides the
 *    collectors' `has`-guards (`if (ctx.externClasses.has(className)) return`)
 *    and therefore what is written at all.
 *
 * The `declare function` branch is deliberately NOT memoised: it depends on the
 * caller's `libReferencedNames` and allocates import/func-type indices, so it
 * re-runs on every compile. It writes neither of the two memoised maps, so the
 * split is state-disjoint.
 */
import type { ts } from "../ts-api.js";
import type { CodegenContext, ExternClassInfo } from "./context/types.js";
import type { LibDeclIndex } from "./lib-decl-index.js";

/** Ordered `set` effects of one memoised lib-file extern-class scan. */
export interface LibExternScanEffects {
  classes: [string, ExternClassInfo][];
  parents: [string, string][];
}

const LIB_EXTERN_SCAN_MEMO = new WeakMap<ts.SourceFile, Map<string, LibExternScanEffects>>();
const LIB_DECL_INDEX_IDS = new WeakMap<LibDeclIndex, number>();
let libDeclIndexIdCounter = 0;
let libScanMemoEpoch = 0;

/**
 * Test seam: drop the memo. A `WeakMap` has no `clear()`, so the epoch (part of
 * every key) is bumped instead — every previously stored entry becomes
 * unreachable.
 */
export function clearExternLibScanMemoForTests(): void {
  libScanMemoEpoch++;
}

function hashKeys(into: number, keys: Iterable<string>): number {
  let h = into;
  for (const k of keys) {
    for (let i = 0; i < k.length; i++) h = (Math.imul(h, 31) + k.charCodeAt(i)) | 0;
    h = (Math.imul(h, 31) + 1) | 0;
  }
  return h;
}

export function libExternScanMemoKey(ctx: CodegenContext, libIndex: LibDeclIndex): string {
  let id = LIB_DECL_INDEX_IDS.get(libIndex);
  if (id === undefined) {
    id = ++libDeclIndexIdCounter;
    LIB_DECL_INDEX_IDS.set(libIndex, id);
  }
  let h = hashKeys(0x1505, ctx.externClasses.keys());
  h = hashKeys(h, ctx.externClassParent.keys());
  h = hashKeys(h, ctx.externClassParent.values());
  const flags = `${ctx.nativeStrings ? 1 : 0}${ctx.standalone ? 1 : 0}${ctx.wasi ? 1 : 0}`;
  return `${libScanMemoEpoch}|${id}|${flags}|${ctx.externClasses.size}:${ctx.externClassParent.size}:${h}`;
}

export function getLibExternScanEffects(sourceFile: ts.SourceFile, key: string): LibExternScanEffects | undefined {
  return LIB_EXTERN_SCAN_MEMO.get(sourceFile)?.get(key);
}

export function putLibExternScanEffects(sourceFile: ts.SourceFile, key: string, effects: LibExternScanEffects): void {
  let perFile = LIB_EXTERN_SCAN_MEMO.get(sourceFile);
  if (!perFile) {
    perFile = new Map();
    LIB_EXTERN_SCAN_MEMO.set(sourceFile, perFile);
  }
  perFile.set(key, effects);
}

/**
 * Diff the two maps against a pre-scan snapshot. Map iteration is insertion
 * order and a re-`set` of an existing key keeps its position, so the changed
 * entries come out in the order the scan wrote them — replaying them in that
 * order reproduces the same final contents AND the same iteration order (which
 * the import/type table emission depends on).
 */
export function captureLibExternScanEffects(
  ctx: CodegenContext,
  beforeClasses: ReadonlyMap<string, ExternClassInfo>,
  beforeParents: ReadonlyMap<string, string>,
): LibExternScanEffects {
  const effects: LibExternScanEffects = { classes: [], parents: [] };
  for (const [name, info] of ctx.externClasses) {
    if (beforeClasses.get(name) !== info) effects.classes.push([name, info]);
  }
  for (const [name, parent] of ctx.externClassParent) {
    if (beforeParents.get(name) !== parent) effects.parents.push([name, parent]);
  }
  return effects;
}

/** Replay recorded effects into a fresh context, cloning so no later in-place
 * mutation of an `ExternClassInfo` can leak from one compile into the next. */
export function applyLibExternScanEffects(ctx: CodegenContext, effects: LibExternScanEffects): void {
  for (const [name, info] of effects.classes) {
    ctx.externClasses.set(name, {
      ...info,
      constructorParams: [...info.constructorParams],
      methods: new Map(info.methods),
      properties: new Map(info.properties),
    });
  }
  for (const [name, parent] of effects.parents) ctx.externClassParent.set(name, parent);
}
