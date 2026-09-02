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
 * Every non-private static METHOD, in source order, under its spec-visible key:
 * an interned string for a folding key, the member's `__cmkey_` global for a
 * runtime one. Two exclusions:
 *
 *  - Static FIELDS keep the `staticProps` global lowering. Mirroring a mutable
 *    slot here would create two sources of truth for it.
 *  - Static ACCESSORS are not installed either. Their compiled halves take the
 *    class STRUCT as the `this` parameter (the collection pass gives every
 *    accessor that receiver, static or not), while an accessor property stored
 *    on this object is invoked by `__call_accessor_get` with the RECEIVER — an
 *    `$Object`. That is an illegal cast at runtime, i.e. a trap, which is worse
 *    than the missing property it would fix. Installing them needs a per-half
 *    trampoline supplying the dummy struct receiver the typed read path already
 *    uses (`property-access.ts::emitGetterCallWithDummy`); until that exists,
 *    the `cpn-class-*-accessors-*` rows stay on the issue's residual list.
 */

import type { Instr } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ts } from "../ts-api.js";
import { allocLocal } from "./context/locals.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { classMemberFuncKey } from "./class-member-keys.js";
import { emitClassMemberKeyOperand } from "./class-proto-accessors.js";
import { emitFuncRefAsClosure } from "./closures/funcref-as-closure.js";
import { hasStaticModifier } from "./ast-modifiers.js";

/**
 * §17 method attributes — `{writable: true, enumerable: false, configurable:
 * true}` in the `__defineProperty_value` flag encoding. Same constant as the
 * prototype installs (`class-proto-object.ts`).
 */
const METHOD_FLAGS = 0x01 | 0x04;

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

/** One installable static method, resolved to its funcMap index. */
interface StaticSidecarMethod {
  /** The name the member is REGISTERED under (possibly `__cmdyn$<n>`). */
  memberName: string;
  funcIdx: number;
}

/**
 * The class's static methods, in `decl.members` order, each resolved to the
 * funcMap entry the install needs. A member whose function does not resolve is
 * skipped rather than installed half-written.
 */
function collectStaticMethods(
  ctx: CodegenContext,
  className: string,
  resolveMemberName: (member: ts.ClassElement) => string | undefined,
): StaticSidecarMethod[] {
  const decl = ctx.classDeclarationMap.get(className);
  if (!decl) return [];
  const out: StaticSidecarMethod[] = [];
  const seen = new Set<string>();
  for (const member of decl.members) {
    if (!hasStaticModifier(member) || !ts.isMethodDeclaration(member) || !member.body) continue;
    const memberName = resolveMemberName(member);
    if (memberName === undefined || memberName.startsWith(PRIVATE_NAME_PREFIX)) continue;
    const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, `${className}_${memberName}`, "static"));
    if (funcIdx === undefined || seen.has(memberName)) continue;
    seen.add(memberName);
    out.push({ memberName, funcIdx });
  }
  return out;
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

  const methods = collectStaticMethods(ctx, className, resolveMemberName);
  if (methods.length === 0) return false;

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
    for (const method of methods) {
      fctx.body.push({ op: "local.get", index: objLocal });
      if (!emitClassMemberKeyOperand(ctx, fctx, className, method.memberName)) {
        ok = false;
        break;
      }
      // The SAME closure value the typed `C.sm` read yields
      // (`property-access-dispatch.ts`), so `gOPD(C,'sm').value === C.sm`.
      if (emitFuncRefAsClosure(ctx, fctx, `${className}_${method.memberName}`, method.funcIdx) === null) {
        ok = false;
        break;
      }
      fctx.body.push({ op: "extern.convert_any" });
      fctx.body.push({ op: "f64.const", value: METHOD_FLAGS });
      fctx.body.push({ op: "call", funcIdx: defineValueIdx });
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
