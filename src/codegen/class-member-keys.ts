// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#1983) Collision-free funcMap key for class-member synthetic names.
 *
 * Leaf module (depends only on the CodegenContext type) so every codegen file
 * — producers in `class-bodies.ts` / `new-super.ts` / `literals.ts` /
 * `object-ops.ts` and consumers in `expressions/calls.ts` / `closures.ts` /
 * `index.ts` — can import it without risking an import cycle.
 */
import type { CodegenContext } from "./context/types.js";

/**
 * Class members register in `ctx.funcMap` under `${className}_${member}` keys
 * (`A_m` for `A.m`, `A_new` for the ctor, `A_get_v` for a getter, …). A
 * top-level user `function A_m() {}` would claim the same flat string key, and
 * `ensureSiblingFunctionsRegistered` then *silently skips* registering the user
 * function because `funcMap.has("A_m")` is already true — so `A_m()` call sites
 * resolve to the class member's funcIdx (wrong signature → validation trap).
 *
 * The fix keeps the funcMap key **byte-identical** (`A_m`) in the overwhelming
 * common case (no user function of that name), and only when a real collision
 * exists relocates the *class member's* funcMap key to a form a user identifier
 * cannot produce (`__cm$A_m`). The user function keeps the bare `A_m` key (it
 * is no longer skipped, because the class member vacated `A_m`), so its many
 * bare-call / export / ref.func consumers are untouched.
 *
 * IMPORTANT: this relocates ONLY the `funcMap` funcIdx key. The parallel
 * membership sets (`classMethodSet`, `staticMethodSet`, `classAccessorSet`,
 * `staticProps`, …) and the per-name metadata maps (`funcOptionalParams`,
 * `funcRestParams`, `funcUsesArguments`, …) keep the legacy
 * `${className}_${member}` string — the sets answer "is this name a class
 * member?" (collision-free), and the method-dispatch consumer reads the
 * metadata by the same legacy `fullName`, so producer and consumer agree.
 * Producers and consumers of the funcMap **funcIdx** must both route the legacy
 * name through this helper so they agree on the relocated key.
 *
 * Known residual (out of scope, does NOT trap): if a program declares BOTH a
 * class member `A.m` *and* a user `function A_m()` *and both* carry optional /
 * rest params, the two share the legacy `funcOptionalParams[A_m]` slot. This
 * affects only optional-arg backfill for that pathological name clash; the
 * funcIdx (the trap cause) is correctly separated.
 */
export function classMemberFuncKey(ctx: CodegenContext, fullName: string): string {
  // Only relocate when the legacy key would actually collide with a top-level
  // user function. Keeps output identical for every non-colliding program.
  if (!ctx.topLevelFunctionNames.has(fullName)) return fullName;
  // Relocate to a prefixed key. The `__cm$` prefix never appears in a
  // `${className}_${member}` join, so it cannot collide with another class
  // member's legacy key. Guard the pathological case where a user also wrote
  // `function __cm$A_m() {}` by appending disambiguators until free.
  let key = `__cm$${fullName}`;
  let n = 0;
  while (ctx.topLevelFunctionNames.has(key)) key = `__cm$${fullName}$${n++}`;
  return key;
}

/**
 * (#1394 / #2963) Walk the class-parent chain to the TOPMOST class that owns
 * the same method funcIdx. When `class D extends C { }` inherits `m` from C,
 * the codegen registers `D_m` with the SAME funcIdx as `C_m`
 * (class-bodies.ts) — two distinct cache-key names would mint two closures
 * with different identity. Spec'd behaviour: method identity follows the
 * OWNING class (`(new D()).m === C.prototype.m`), so canonicalise the cache
 * key to the topmost inheriting owner. Stops at an OVERRIDE (parent has a
 * DIFFERENT funcIdx for the same member name).
 *
 * Extracted from the typed method-value read (`compileInstanceMember`'s
 * inline `ownerNameForChain`) so the member-get dispatcher (#2963 dynamic
 * `any`-receiver method reads) resolves the IDENTICAL owner → identical
 * cache global → `c.m === C.prototype.m` holds across both read paths.
 */
export function resolveMethodOwnerClass(ctx: CodegenContext, start: string, propName: string): string {
  const startFull = `${start}_${propName}`;
  const startIdx = ctx.funcMap.get(classMemberFuncKey(ctx, startFull));
  if (startIdx === undefined) return start; // not a method we know
  let bestOwner = start;
  let cls: string | undefined = ctx.classParentMap.get(start);
  const seen = new Set<string>([start]);
  while (cls && !seen.has(cls)) {
    seen.add(cls);
    const full = `${cls}_${propName}`;
    const parentIdx = ctx.funcMap.get(classMemberFuncKey(ctx, full));
    if (parentIdx === undefined) break; // parent doesn't have this method
    if (parentIdx === startIdx) {
      // Inherited (same funcIdx) — keep walking up.
      bestOwner = cls;
      cls = ctx.classParentMap.get(cls);
      continue;
    }
    // Parent has a DIFFERENT funcIdx → start overrides the method.
    // Identity must use start's cache, not the parent's.
    break;
  }
  return bestOwner;
}
