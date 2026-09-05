// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#5195 Step 2) A parallel `$Object` carrying a class's STATIC members.
 *
 * The class object itself is a `$ClassName` struct singleton
 * (`expressions/extern.ts::emitLazyClassObjectGet`) and, per #3976, cannot be
 * converted to a real `$Object`: `new-super.ts::emitDynamicNewFallback` and
 * `property-access.ts::tryEmitConstructorViaTag` `ref.test` that value against
 * each class struct type and read its `__tag`, so a representation change
 * silently breaks value-bound `new K(...)`.
 *
 * So the static surface gets its own object instead, and the dynamic member
 * lookup is REDIRECTED to it when the receiver is the class-object singleton
 * (`class-proto-lookup.ts`). The class object keeps its struct identity; the
 * sidecar answers the questions a struct cannot.
 *
 * ## Why this exists at all (the runtime-key half)
 *
 * `class C { static [x || 1]() {} }` installs a member under a key known only
 * at ClassDefinitionEvaluation. It has no source-spellable name — #5195 Step 1
 * carries it internally as `__cmdyn$<ordinal>` — so no static dispatch ladder
 * can reach it and `C[x || 1]()` folded to `ref.null.extern`. The prototype
 * side of that problem is solved by the prototype `$Object` (#3976); this is
 * the static twin, and it is why the sidecar is currently built only for
 * classes that HAVE such a member. Widening it to every class with statics is
 * the rest of #5195 cluster B (`gOPD(C,'sm')`, `C.hasOwnProperty('sm')`,
 * `length`/`name`/`prototype` through reflection), which additionally needs the
 * reflective natives redirected, not just `__extern_get`.
 *
 * ## What is installed, and what is deliberately not
 *
 * Every non-private static METHOD and static ACCESSOR, in `decl.members` order,
 * under its spec-visible key: an interned string for a folding key, the member's
 * `__cmkey_` global for a runtime one. §15.7.14 defines members in TEXTUAL
 * order, so the emitted install sequence IS that order and a later same-key
 * member replaces the earlier one — which is the only mechanism available for a
 * runtime key, whose collisions are unknowable at compile time (#5318 r4 review,
 * finding 1). Two exclusions:
 *
 *  - Static FIELDS keep the `staticProps` global lowering. Mirroring a mutable
 *    slot here would create two sources of truth for it. KNOWN RESIDUAL: a
 *    dynamic read of a runtime key that collides with a static field name
 *    therefore sees the sidecar's accessor/method where §15.7.14 (static field
 *    initializers run after every method and accessor is installed) says the
 *    FIELD wins, in either declaration order —
 *    `class Q { static get [x||"k"]() { return 11; } static k = 7; }` answers 11
 *    where node answers 7. Base answers `undefined`; both are wrong, and closing
 *    it means widening the sidecar to fields, i.e. the two-sources-of-truth
 *    exclusion above.
 *  - Static ACCESSORS are installed ONLY when the half's body never reads the
 *    receiver (#5318 Step 1c). Their
 *    compiled halves take the class STRUCT as the `this` parameter — the
 *    collection pass gives every accessor that receiver, static or not — while
 *    an accessor property stored on this object is invoked by
 *    `__call_accessor_get` with the RECEIVER, an `$Object`. For a half that
 *    READS the receiver that mismatch is an illegal cast at runtime, i.e. a
 *    trap, which is worse than the missing property it would fix; for a half
 *    that never reads it, the cached method trampoline already puts a null in
 *    the slot (`methodBodyReadsThis` in `closures/method-trampolines.ts`) and
 *    nothing observes the difference. So the receiver-free halves — which is
 *    every `static get [k]() { return <literal>; }` in the
 *    `cpn-class-*-accessors-*` family — are installed, and a receiver-reading
 *    one keeps the old missing-property answer rather than gaining a trap. The
 *    predicate reads the COMPILED body, not the syntax: the syntactic
 *    `genBodyReferencesThis` stops descending at a nested class and so installed
 *    a half that traps (#5318 r4 review, finding 2). See
 *    {@link staticAccessorHalfIsReceiverFree}.
 *    Lifting the restriction needs a per-half trampoline supplying the dummy
 *    struct receiver the typed read path already uses
 *    (`property-access.ts::emitGetterCallWithDummy`).
 */

import type { Instr } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ts } from "../ts-api.js";
import { allocLocal } from "./context/locals.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { classMemberFuncKey } from "./class-member-keys.js";
import { classAccessorInstallFlags, emitClassMemberKeyOperand } from "./class-proto-accessors.js";
import { emitFuncRefAsClosure } from "./closures/funcref-as-closure.js";
import { compiledBodyReadsThis, emitCachedMethodClosureAccess } from "./closures/method-trampolines.js";
import { hasStaticModifier } from "./ast-modifiers.js";

/**
 * §17 method attributes — `{writable: true, enumerable: false, configurable:
 * true}` in the `__defineProperty_value` flag encoding, PLUS bit 7
 * (`HOST_HAS_VALUE`), which says the descriptor really carries a `[[Value]]`.
 *
 * The prototype installs (`class-proto-object.ts`) omit bit 7 and cannot
 * observe the difference: they only ever define a fresh key, and the bit is
 * read on the REDEFINE path. The sidecar does redefine — a static method that
 * follows a same-key static accessor — and there §10.1.6.3 step 6 treats a
 * descriptor with neither `[[Value]]` nor `[[Writable]]` as GENERIC, so
 * `object-runtime-descriptors.ts`'s `keepAccessor` arm updates the attributes
 * and leaves the accessor halves LIVE. Without bit 7 the method install was a
 * silent no-op over the accessor and `C[k]` answered the getter in BOTH
 * declaration orders (#5318 r4 review, finding 1).
 */
const METHOD_FLAGS = 0x01 | 0x04 | (1 << 7);

/** The `__priv_` prefix `resolveClassMemberName` gives `#private` elements. */
const PRIVATE_NAME_PREFIX = "__priv_";

/**
 * True when {@link emitClassStaticSidecar} would build a sidecar for this
 * class. Pure predicate — no emission, no context mutation.
 */
export function classStaticSidecarApplies(ctx: CodegenContext, className: string): boolean {
  if (!ctx.standalone) return false;
  if (ctx.classObjectGlobals?.get(className) === undefined) return false;
  if (ctx.classStaticSidecarGlobals.get(className) === undefined) return false;
  // Narrow by design (see the module header): only a class with a static member
  // whose key is known at runtime, which is the case no static dispatch ladder
  // can serve at all.
  return (ctx.classDynamicMembers.get(className) ?? []).some((member) => member.isStatic);
}

/** One installable static member, resolved to the funcMap entries it needs. */
type StaticSidecarEntry =
  | {
      kind: "method";
      /** The name the member is REGISTERED under (possibly `__cmdyn$<n>`). */
      memberName: string;
      funcIdx: number;
    }
  | {
      kind: "accessor";
      memberName: string;
      getterFuncIdx?: number;
      setterFuncIdx?: number;
    };

/**
 * (#5318 r4 review, finding 2) True when this accessor half can be invoked with
 * the sidecar `$Object` as the receiver: its COMPILED body never reads the
 * receiver, so the class-struct parameter the half declares is never touched and
 * the null the cached trampoline puts there is unobservable.
 *
 * The gate is the compiled body — the same `local.get 0` scan the method
 * trampoline itself uses — and nothing else. The half's own funcMap entry is
 * already filled by the time the sidecar is emitted, so the answer is available
 * and it is the ONLY predicate that cannot be wrong by construction.
 *
 * The syntactic predicate this replaces (`genBodyReferencesThis`) was wrong in
 * the dangerous direction: it stops descending at `ts.isClassLike`, so
 * `static get [k]() { class X { static f = this; } return 6; }` read as
 * receiver-free, the half was installed, and the call TRAPPED uncatchably where
 * declining had merely answered `undefined`. Writing a more conservative walker
 * instead trades that for the opposite error — it declines halves that are
 * genuinely receiver-free (a nested object literal's computed key, say) and
 * turns a CORRECT answer into a missing property.
 *
 * `undefined` — no defined function, or a minted-but-still-EMPTY body — is a
 * DECLINE. An empty instruction list must never read as "receiver-free".
 */
function staticAccessorHalfIsReceiverFree(ctx: CodegenContext, member: ts.ClassElement, funcIdx: number): boolean {
  if (!ts.isGetAccessorDeclaration(member) && !ts.isSetAccessorDeclaration(member)) return false;
  if (member.body === undefined) return false;
  return compiledBodyReadsThis(ctx, funcIdx) === false;
}

/**
 * The class's installable static members in `decl.members` order — §15.7.14
 * defines them in TEXTUAL order, so a later member under the same key replaces
 * an earlier one (a method after an accessor replaces the pair; an accessor
 * after a method replaces the value) and the two halves of one accessor merge
 * into a single entry.
 *
 * Replacement keeps the FIRST definition's slot, matching
 * `OrdinaryDefineOwnProperty` on an existing key, which does not move it in
 * own-key order. A member whose function does not resolve, or an accessor half
 * that reads the receiver, is skipped rather than installed half-written.
 *
 * A RUNTIME-keyed member cannot be deduplicated here at all — its registered
 * name is a synthetic `__cmdyn$<n>` and only ClassDefinitionEvaluation knows
 * which of them collide. For those the ORDER of the emitted installs is the
 * whole mechanism: `__defineProperty_value` over a live accessor replaces it,
 * and `__defineProperty_accessor` over a live data property replaces that, so
 * textual order at emit time is textual order at run time.
 */
function collectStaticSidecarEntries(
  ctx: CodegenContext,
  className: string,
  resolveMemberName: (member: ts.ClassElement) => string | undefined,
): StaticSidecarEntry[] {
  const decl = ctx.classDeclarationMap.get(className);
  if (!decl) return [];
  const out: StaticSidecarEntry[] = [];
  const slotOf = new Map<string, number>();
  const place = (memberName: string, entry: StaticSidecarEntry): void => {
    const slot = slotOf.get(memberName);
    if (slot === undefined) {
      slotOf.set(memberName, out.length);
      out.push(entry);
      return;
    }
    out[slot] = entry;
  };
  for (const member of decl.members) {
    if (!hasStaticModifier(member)) continue;
    const memberName = resolveMemberName(member);
    if (memberName === undefined || memberName.startsWith(PRIVATE_NAME_PREFIX)) continue;
    if (ts.isMethodDeclaration(member) && member.body) {
      const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, `${className}_${memberName}`, "static"));
      if (funcIdx === undefined) continue;
      place(memberName, { kind: "method", memberName, funcIdx });
      continue;
    }
    if (!ts.isGetAccessorDeclaration(member) && !ts.isSetAccessorDeclaration(member)) continue;
    const isGetter = ts.isGetAccessorDeclaration(member);
    const half = ctx.funcMap.get(classMemberFuncKey(ctx, `${className}_${isGetter ? "get" : "set"}_${memberName}`));
    if (half === undefined || !staticAccessorHalfIsReceiverFree(ctx, member, half)) continue;
    const slot = slotOf.get(memberName);
    const live = slot === undefined ? undefined : out[slot];
    // A sibling half under the SAME folded key merges; anything else (a method,
    // or nothing yet) is replaced by a fresh single-half entry.
    const merged: StaticSidecarEntry =
      live !== undefined && live.kind === "accessor"
        ? { ...live, ...(isGetter ? { getterFuncIdx: half } : { setterFuncIdx: half }) }
        : { kind: "accessor", memberName, ...(isGetter ? { getterFuncIdx: half } : { setterFuncIdx: half }) };
    place(memberName, merged);
  }
  return out;
}

/**
 * Push one accessor half onto the stack: the cached method closure when the
 * half exists, `ref.null.extern` when it does not. Returns `false` when the
 * closure could not be built, in which case the caller abandons the sidecar
 * rather than publish a half-written accessor.
 */
function emitStaticAccessorHalf(
  ctx: CodegenContext,
  fctx: FunctionContext,
  halfName: string,
  funcIdx: number | undefined,
  structTypeIdx: number,
): boolean {
  if (funcIdx === undefined) {
    fctx.body.push({ op: "ref.null.extern" });
    return true;
  }
  return emitCachedMethodClosureAccess(ctx, fctx, halfName, funcIdx, structTypeIdx);
}

/**
 * Emit the lazy-initialized static sidecar `$Object` for `className`, leaving
 * its externref on the stack. Returns `false` without emitting anything when
 * the object runtime cannot supply the helpers or nothing is installable — the
 * caller must then treat the class as having no sidecar.
 *
 * `resolveMemberName` is injected (rather than imported from `class-bodies.ts`)
 * to keep this module out of that file's import cycle; callers pass the same
 * `resolveInstallableClassMemberName` the collection pass used, so the names
 * here are byte-identical to the ones in `funcMap`.
 */
export function emitClassStaticSidecar(
  ctx: CodegenContext,
  fctx: FunctionContext,
  className: string,
  resolveMemberName: (member: ts.ClassElement) => string | undefined,
): boolean {
  if (!classStaticSidecarApplies(ctx, className)) return false;
  const sidecarGlobalIdx = ctx.classStaticSidecarGlobals.get(className)!;

  ensureObjectRuntime(ctx);
  const newObjectIdx = ctx.funcMap.get("__new_plain_object");
  const defineValueIdx = ctx.funcMap.get("__defineProperty_value");
  if (newObjectIdx === undefined || defineValueIdx === undefined) return false;

  const entries = collectStaticSidecarEntries(ctx, className, resolveMemberName);
  if (entries.length === 0) return false;
  const hasAccessor = entries.some((entry) => entry.kind === "accessor");
  const defineAccessorIdx = hasAccessor ? ctx.funcMap.get("__defineProperty_accessor") : undefined;
  if (hasAccessor && defineAccessorIdx === undefined) return false;
  const structTypeIdx = hasAccessor ? ctx.structMap.get(className) : undefined;
  if (hasAccessor && structTypeIdx === undefined) return false;

  const objLocal = allocLocal(fctx, `__class_static_obj_${fctx.locals.length}`, { kind: "externref" });
  const initBody: Instr[] = [
    { op: "call", funcIdx: newObjectIdx },
    { op: "local.set", index: objLocal },
  ];

  // Same detached-body discipline as `emitStandaloneClassProtoObject`: the
  // installs bake `ref.func`s and can add late imports, so the swapped-out body
  // must be walkable by the funcidx shifter while this one is being built.
  const savedBody = fctx.body;
  fctx.body = initBody;
  ctx.liveBodies.add(savedBody);
  let ok = true;
  try {
    // (#5318 r4 review, finding 1) ONE pass in `decl.members` order — methods
    // and accessor entries interleaved. Order is load-bearing for a runtime key,
    // where a later same-key member cannot be folded into the earlier one at
    // compile time and only the emitted install sequence gets §15.7.14 right.
    // Each accessor half marks ITSELF specified so a `get [k]`/`set [k]` pair
    // under one evaluated key merges instead of the second erasing the first.
    for (const entry of entries) {
      fctx.body.push({ op: "local.get", index: objLocal });
      if (!emitClassMemberKeyOperand(ctx, fctx, className, entry.memberName)) {
        ok = false;
        break;
      }
      if (entry.kind === "method") {
        // The SAME closure value the typed `C.sm` read yields
        // (`property-access-dispatch.ts`), so `gOPD(C,'sm').value === C.sm`.
        if (emitFuncRefAsClosure(ctx, fctx, `${className}_${entry.memberName}`, entry.funcIdx) === null) {
          ok = false;
          break;
        }
        fctx.body.push({ op: "extern.convert_any" });
        fctx.body.push({ op: "f64.const", value: METHOD_FLAGS });
        fctx.body.push({ op: "call", funcIdx: defineValueIdx });
        fctx.body.push({ op: "drop" });
        continue;
      }
      if (
        !emitStaticAccessorHalf(
          ctx,
          fctx,
          `${className}_get_${entry.memberName}`,
          entry.getterFuncIdx,
          structTypeIdx!,
        ) ||
        !emitStaticAccessorHalf(ctx, fctx, `${className}_set_${entry.memberName}`, entry.setterFuncIdx, structTypeIdx!)
      ) {
        ok = false;
        break;
      }
      fctx.body.push({
        op: "f64.const",
        value: classAccessorInstallFlags({
          name: entry.memberName,
          ...(entry.getterFuncIdx !== undefined ? { getterFuncIdx: entry.getterFuncIdx } : {}),
          ...(entry.setterFuncIdx !== undefined ? { setterFuncIdx: entry.setterFuncIdx } : {}),
        }),
      });
      fctx.body.push({ op: "call", funcIdx: defineAccessorIdx! });
      fctx.body.push({ op: "drop" });
    }
    if (ok) {
      fctx.body.push({ op: "local.get", index: objLocal });
      fctx.body.push({ op: "global.set", index: sidecarGlobalIdx });
    }
  } finally {
    fctx.body = savedBody;
    ctx.liveBodies.delete(savedBody);
  }
  if (!ok) return false;

  fctx.body.push({ op: "global.get", index: sidecarGlobalIdx });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: initBody, else: [] });
  fctx.body.push({ op: "global.get", index: sidecarGlobalIdx });
  return true;
}
