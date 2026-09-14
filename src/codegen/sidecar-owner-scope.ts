// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5383 S2e R10) Scope-discriminate `ctx.sidecarDefinedPropertyKeys`.
 *
 * That set is keyed by `"<identifierTEXT>:<propName>"` — module-wide and
 * scope-blind. A single `Object.defineProperty(e, "length", …)` anywhere in the
 * program therefore routes EVERY `e.length` read in EVERY function through
 * `emitRuntimeDescriptorGet`, including one whose `e` is an unrelated local. The
 * runtime sidecar has no descriptor for that other object, so the read answers
 * `undefined`.
 *
 * Measured on the compiled `@js-temporal/polyfill` bundle (2026-09-08,
 * `--target standalone`): the bundle contains one `Object.defineProperty(e,
 * "length", …)`, and its ASCII-lowercase helper
 * `function Ao(e){let t="";for(let n=0;n<e.length;n++)…}` then read `e.length`
 * as `undefined`, so the loop never ran, `Ao("iso8601")` answered `""`, and
 * `new Temporal.PlainDate(2024,1,1)` threw `RangeError: invalid calendar
 * identifier `. Renaming that one local to `zqx` — nothing else — made the same
 * function correct, which is what identifies the key rather than the lowering.
 *
 * The fix records WHICH binding each key was recorded for, using the binding's
 * declaration node (via `ctx.oracle.valueDeclarationOf`, not the raw checker),
 * and lets a reader decline when it is provably looking at a different binding.
 *
 * Three properties make this answer-preserving:
 *
 * 1. **A key with no recorded owner keeps its old, module-wide meaning.** Two
 *    of the four writers (`object-shape-widening`'s dynamic-descriptor arms)
 *    only ever hold the variable NAME, so they record `null` = unscoped and the
 *    key behaves exactly as before.
 * 2. **An unresolvable receiver keeps the old meaning too.** If either side
 *    cannot be resolved to a declaration the guard answers `true` (covered), so
 *    the change can only ever REMOVE a wrong-binding match, never add one.
 * 3. **The state is per-`CodegenContext`** (a `WeakMap`), so it is born and dies
 *    with the compile that populated `sidecarDefinedPropertyKeys` itself; there
 *    is no cross-compile leakage and no growth in the context type.
 */
import type ts from "typescript";
import type { CodegenContext } from "./context/types.js";

/** `key -> owning declarations`, or `null` when a writer could not name one. */
const OWNERS = new WeakMap<CodegenContext, Map<string, Set<ts.Declaration> | null>>();

function ownersFor(ctx: CodegenContext): Map<string, Set<ts.Declaration> | null> {
  let map = OWNERS.get(ctx);
  if (map === undefined) {
    map = new Map();
    OWNERS.set(ctx, map);
  }
  return map;
}

/**
 * Record the binding a `sidecarDefinedPropertyKeys` entry was added FOR. Pass
 * `receiver === undefined` (or an expression that is not a resolvable
 * identifier) to mark the key unscoped, which restores the pre-#5383 behaviour
 * for that key.
 */
export function recordSidecarPropertyOwner(ctx: CodegenContext, key: string, receiver?: ts.Expression): void {
  const map = ownersFor(ctx);
  const existing = map.get(key);
  if (existing === null) return; // already unscoped — cannot become narrower
  const decl = receiver === undefined ? undefined : ctx.oracle.valueDeclarationOf(receiver);
  if (decl === undefined) {
    map.set(key, null);
    return;
  }
  if (existing === undefined) map.set(key, new Set([decl]));
  else existing.add(decl);
}

/**
 * Does `key` apply to THIS receiver? `true` whenever the answer is not provably
 * "different binding" — see property (2) in the module comment.
 */
export function sidecarKeyCoversReceiver(ctx: CodegenContext, key: string, receiver: ts.Expression): boolean {
  const owners = OWNERS.get(ctx)?.get(key);
  if (owners === undefined || owners === null || owners.size === 0) return true;
  const decl = ctx.oracle.valueDeclarationOf(receiver);
  if (decl === undefined) return true;
  return owners.has(decl);
}
