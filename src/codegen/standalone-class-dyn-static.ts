// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#5383 S2i) A RUNTIME-key read of a standalone class VALUE must reach the
// class's STATIC members — `C[k]` / `K.mk(7)` where `k` names a static method
// or a static accessor.
//
// ## The gap (measured 2026-09-12, `.tmp/probe.mts`, one module, no Temporal)
//
// ```js
// class C { static sf = 7; static mk(a){return a+1;} static get acc(){return 11;} }
// function readDyn(o, k) { return o[k]; }
// ```
//
// | probe                              | before | after |
// | ---------------------------------- | ------ | ----- |
// | `readDyn(C, "mk")` — static METHOD  | `undefined` | the method closure |
// | `C[k](5)` with `k="mk"`             | `undefined` (then `NaN`) | `6` |
// | `readDyn(C, "acc")` — static ACCESSOR | `undefined` | `11` |
// | `readDyn(C, "sf")` — static FIELD    | `undefined` | `undefined` (unchanged) |
// | `C.sf` / `C.mk(5)` / `C.acc` — TYPED | 7 / 6 / 11 | 7 / 6 / 11 |
//
// S2h fixed the INSTANCE half of this (`o[k]` reaching the class prototype).
// The class OBJECT is a different receiver: #3976 deliberately left it a
// `$ClassName` struct (`emitDynamicNewFallback` / `tryEmitConstructorViaTag`
// `ref.test` that value), so its static surface lives in the #5195 Step 2
// static SIDECAR `$Object`. `class-proto-lookup.ts`'s class-object arm already
// routes a class-value receiver to that sidecar and answers **null** when there
// is none — and there is none for all but a class with a RUNTIME-KEYED static,
// which is the scope #5195 Step 2 shipped with.
//
// This module widens that scope the way S2h widened the prototype one: from a
// demand recorded at the read site, materialized by a finalize-minted per-class
// builder rather than by moving ClassDefinitionEvaluation.
//
// ## The precedence question, answered by measurement before widening
//
// The sidecar carries static METHODS and ACCESSORS and deliberately NOT static
// FIELDS — mirroring a mutable slot would make two sources of truth for it. So
// the question S2h deferred was whether routing every class-value read through
// the sidecar SHADOWS the `staticProps` lowering of a static field.
//
// It does not, and the reason is that there was never an overlap to shadow:
// `ctx.staticProps` is a purely SYNTACTIC lowering (`C.sf` -> `global.get
// __static_C_sf`, `property-access-dispatch.ts`). It has no runtime name->slot
// map, so the DYNAMIC read `C[k]` with `k="sf"` never consulted it and answered
// `undefined` on base — measured above, before and after a `C.sf = 42` write.
// After the widening it still answers `undefined`, because the sidecar simply
// has no such key and `__extern_get` falls through to the same miss. The TYPED
// reads and writes are untouched: they never reach `__extern_get` at all.
//
// So the precedence is: **typed reads keep `staticProps`, which stays the one
// source of truth for a static field; the sidecar answers only the
// method/accessor surface the typed ladders also serve.** The residual is the
// pre-existing #5195 one (a dynamic read of a static FIELD is `undefined`
// rather than its value), unchanged in either direction by this slice. Closing
// it needs the field mirrored as an ACCESSOR pair over its `staticProps` global
// — single-source-of-truth, but a per-field minted getter/setter, which is a
// slice of its own.
//
// ## Why the demand set is SHARED with S2h's, not a new one
//
// A class OBJECT and its instances are the SAME wasm struct type (`$C`) — that
// is the whole of #3976. So at the read site, where the only narrowing
// available is the receiver's struct type (or nothing at all, for an
// externref), "this read may land on an instance of C" and "this read may land
// on the class object C" are literally the same predicate. A separate set would
// be populated from the identical condition at the identical sites.
// `ctx.standaloneRuntimeKeyClassProtos` is therefore read directly here.

import type { ts } from "../ts-api.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ts as tsApi } from "../ts-api.js";
import { emitClassStaticSidecar } from "./class-static-sidecar.js";
import { hasStaticModifier } from "./ast-modifiers.js";
import { resolveInstallableClassMemberName } from "./class-bodies.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { nextModuleGlobalIdx } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";

/** The per-class static-sidecar builder minted by {@link mintStandaloneClassStaticBuilders}. */
export function classStaticBuilderName(className: string): string {
  return `__class_static_build_${className}`;
}

/**
 * A cheap syntactic pre-check: does this class declare anything the sidecar
 * would install (a static method with a body, or a static accessor)?
 *
 * Asked BEFORE the sidecar global is registered, because a registration whose
 * build then declines would leave a dead global in the module and move the
 * bytes of a class that gained nothing. It is intentionally a superset of what
 * `collectStaticSidecarEntries` accepts — a receiver-reading accessor half is
 * still declined there — so the only cost of a mismatch is that one dead
 * global, never a wrong answer.
 */
function declaresInstallableStatic(ctx: CodegenContext, className: string): boolean {
  const decl = ctx.classDeclarationMap.get(className);
  if (!decl) return false;
  return decl.members.some((member: ts.ClassElement) => {
    if (!hasStaticModifier(member)) return false;
    if (tsApi.isMethodDeclaration(member)) return member.body !== undefined;
    return tsApi.isGetAccessorDeclaration(member) || tsApi.isSetAccessorDeclaration(member);
  });
}

/**
 * Mint one `__class_static_build_<C>()` per demand-admitted class, so
 * `__class_proto_lookup`'s class-object arm can materialize a static sidecar
 * that ClassDefinitionEvaluation never built.
 *
 * Runs at FINALIZE, immediately before {@link mintStandaloneClassProtoBuilders}
 * and for the same two reasons that pin that one: every `<C>_<member>` function
 * must already be registered (a read site is free to compile before the class
 * body), and the builder creates the canonical method-closure singletons whose
 * arities the `__call_fn_method_<N>` dispatchers are emitted over — so minting
 * after that emission leaves a static ACCESSOR's arity with no dispatcher and
 * `fillAccessorDrivers` silently falls back to returning `undefined`. That
 * failure mode is exactly S2h's, and it is invisible on a static METHOD (a data
 * property needs no accessor driver).
 *
 * The body is `emitClassStaticSidecar` + `drop` — the SAME emission
 * ClassDefinitionEvaluation produces for a runtime-keyed class, including its
 * own lazy `ref.is_null` guard, so the builder is idempotent and a class that
 * reaches it by both routes ends up with the ONE singleton.
 */
export function mintStandaloneClassStaticBuilders(ctx: CodegenContext): void {
  if (!ctx.standalone) return;
  // (#5383 S2h/S2i) A module compiled as a linked PROVIDER for a wasm consumer
  // has no read site of its own — the read happens in the OTHER module and
  // arrives through the S2d boundary terminal — so it cannot know which class
  // will be asked, and every class it owns has to be reachable. Same seed, same
  // argument as the prototype builders.
  if (ctx.exportsConsumedByWasm === true) {
    for (const className of ctx.classSet) ctx.standaloneRuntimeKeyClassProtos.add(className);
  }
  if (ctx.standaloneRuntimeKeyClassProtos.size === 0) return;

  const candidates = [...ctx.standaloneRuntimeKeyClassProtos].sort().filter((className) => {
    if (ctx.funcMap.has(classStaticBuilderName(className))) return false;
    // Already built eagerly at ClassDefinitionEvaluation (#5195 Step 2): the
    // global is non-null before any read can run, so a builder would be dead
    // code. Those classes keep byte-identical arms.
    if (ctx.classStaticSidecarGlobals.has(className)) return false;
    if (ctx.classObjectGlobals.get(className) === undefined) return false;
    return declaresInstallableStatic(ctx, className);
  });
  if (candidates.length === 0) return;

  const voidTypeIdx = addFuncType(ctx, [], [], "$class_static_build_type");
  for (const className of candidates) {
    const sidecarGlobalIdx = nextModuleGlobalIdx(ctx);
    ctx.mod.globals.push({
      name: `__static_${className}`,
      type: { kind: "externref" },
      mutable: true,
      init: [{ op: "ref.null.extern" }],
    });
    ctx.classStaticSidecarGlobals.set(className, sidecarGlobalIdx);

    const decl = ctx.classDeclarationMap.get(className)!;
    // A synthetic context so the sidecar emission — which appends to `fctx.body`
    // and allocates locals — can run outside any user function. Same shape as
    // the prototype builder's.
    const builderFctx: FunctionContext = {
      name: classStaticBuilderName(className),
      params: [],
      locals: [],
      localMap: new Map(),
      returnType: null,
      body: [],
      blockDepth: 0,
      breakStack: [],
      continueStack: [],
      labelMap: new Map(),
      savedBodies: [],
    };
    const emitted = emitClassStaticSidecar(ctx, builderFctx, className, (member) =>
      resolveInstallableClassMemberName(ctx, className, decl, member),
    );
    if (!emitted) {
      // Nothing installable after all (every accessor half reads its receiver,
      // say). Withdraw the registration so the lookup's class-object arm keeps
      // answering the null it answered before — the global stays, harmlessly
      // null, because the closure singletons the attempt may have allocated
      // make popping it unsound.
      ctx.classStaticSidecarGlobals.delete(className);
      continue;
    }
    builderFctx.body.push({ op: "drop" });
    const funcIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, funcIdx, {
      name: classStaticBuilderName(className),
      typeIdx: voidTypeIdx,
      locals: builderFctx.locals,
      body: builderFctx.body,
      exported: false,
    });
    ctx.funcMap.set(classStaticBuilderName(className), funcIdx);
  }
}
