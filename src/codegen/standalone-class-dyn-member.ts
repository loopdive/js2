// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#5383 S2h) A RUNTIME-key read of a standalone class instance must reach the
// class's PROTOTYPE members — `o[k]` where `k` names a getter or a method.
//
// ## The gap (measured 2026-09-08, `.tmp/r6.js`, one module, no Temporal)
//
// ```js
// class PlainDate { constructor(d){this._d=d;} get day(){return this._d;} sum(k){return this._d+k;} }
// function readDyn(o, k) { return o[k]; }
// ```
//
// | probe                                            | before |
// | ------------------------------------------------ | ------ |
// | `readDyn(new PlainDate(7), "_d")` — an OWN field | 7      |
// | `new PlainDate(7).sum(1)` through an `any`       | 8 (the `__call_m_sum_1` closed dispatcher) |
// | `readDyn(new PlainDate(7), "day")` — an ACCESSOR | `undefined` |
// | `readDyn(new PlainDate(7), "sum")` — a METHOD    | `undefined` |
//
// The generic `__extern_get` ladder serves a closed `$ClassName` struct's own
// declared fields and its #4194 expando bag, and it has no notion of that
// struct's prototype. Only the dynamic method-CALL path (`closed-method-
// dispatch.ts`) consults the class, and it does so per METHOD NAME, at a call
// site — so reading the member as a value answers nothing.
//
// ## Why this is a demand record and not an emitter
//
// #5195 Step 1.7 already built the missing link — `__class_proto_lookup` maps a
// class-instance receiver to its prototype `$Object` and `__extern_get`
// delegates there — but scoped it to classes with a RUNTIME-KEYED member
// (`class C { [ID('d')]() {} }`), because those are the only classes whose
// prototype `$Object` is force-built at ClassDefinitionEvaluation. For every
// other class `__proto_<C>` is LAZY: null until something reads `C.prototype`,
// so a widened lookup answers null and the read misses exactly as before.
// Measured: widening `classesNeedingLookup` alone changed nothing; the same
// probe with a `PlainDate.prototype` read added ahead of it answered the method
// correctly. That is the whole of #5195's deferred "Step 4.3 needs the
// force-init question answered for the general case first".
//
// This module answers it WITHOUT moving ClassDefinitionEvaluation: a read site
// records that some class instance may reach it, and finalize mints one
// per-class builder `__class_proto_build_<C>` that materializes the prototype
// on demand. `__class_proto_lookup`'s arm calls the builder only when its
// global is still null, so the cost is one null test on a lookup that already
// matched the class, and nothing at all before the first such read.
//
// Recording is deliberately COARSE (every class, for an externref receiver) for
// the same reason #5358's host twin is: a runtime key has no name, and nothing
// narrows which instance an `any` holds.
//
// ## Byte-neutrality
//
// The set is written only from the runtime-key read sites, and only under
// `ctx.standalone || ctx.wasi`. A standalone module with no such read records
// nothing, mints no builder, widens no lookup, and emits its previous bytes —
// verified by sha256 A/B over 6 modules × {gc, standalone} in #5383's S2h notes.

import type { CodegenContext, FunctionContext } from "./context/types.js";
import { standaloneClassProtoObjectApplies } from "./class-proto-object.js";
import { emitLazyProtoGet } from "./expressions/extern.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";

/** Guard against a malformed `classParentMap` cycle while walking. */
const MAX_CLASS_DEPTH = 64;

/** The per-class prototype builder minted by {@link mintStandaloneClassProtoBuilders}. */
export function classProtoBuilderName(className: string): string {
  return `__class_proto_build_${className}`;
}

function ancestorsOf(ctx: CodegenContext, className: string): string[] {
  const out: string[] = [];
  let current = ctx.classParentMap.get(className);
  for (let depth = 0; current !== undefined && depth < MAX_CLASS_DEPTH; depth++) {
    out.push(current);
    current = ctx.classParentMap.get(current);
  }
  return out;
}

/**
 * Record that a runtime-key read may need the prototype members of a compiled
 * class instance.
 *
 * `receiverStructTypeIdx` is the receiver's struct type when the read site
 * knows it is a `$ClassName` struct; `undefined` for an externref receiver,
 * which cannot be narrowed and therefore seeds every class. A struct receiver
 * that is not a class instance (an object literal, a tuple) records nothing —
 * its members are struct fields the read already reaches.
 *
 * Mirrors `recordRuntimeKeyClassMethodRead` (#5358) arm for arm; the two are
 * lane-disjoint (that one returns early under standalone, this one under a JS
 * host) so a read site can call both unconditionally.
 */
export function recordStandaloneRuntimeKeyClassMemberRead(ctx: CodegenContext, receiverStructTypeIdx?: number): void {
  if (!(ctx.standalone || ctx.wasi) || ctx.classSet.size === 0) return;
  let classes: Iterable<string>;
  if (receiverStructTypeIdx === undefined) {
    classes = ctx.classSet;
  } else {
    const seeds = [...ctx.classSet].filter((className) => ctx.structMap.get(className) === receiverStructTypeIdx);
    if (seeds.length === 0) return;
    // Ancestors: an inherited member is installed on the ANCESTOR's prototype,
    // and the §15.7.14 step 6 chain link is what carries the read up to it, so
    // the ancestor's prototype has to exist too. Descendants: a `Base`-typed
    // binding may hold a `Derived`, whose own prototype starts the walk.
    const family = new Set<string>(seeds);
    for (const seed of seeds) for (const ancestor of ancestorsOf(ctx, seed)) family.add(ancestor);
    for (const className of ctx.classSet) {
      if (family.has(className)) continue;
      if (ancestorsOf(ctx, className).some((ancestor) => seeds.includes(ancestor))) family.add(className);
    }
    classes = family;
  }
  for (const className of classes) ctx.standaloneRuntimeKeyClassProtos.add(className);
}

/**
 * Mint one `__class_proto_build_<C>()` per recorded class, so
 * `__class_proto_lookup` can materialize a prototype singleton that
 * ClassDefinitionEvaluation left lazy.
 *
 * Runs at FINALIZE, immediately before `fillClassProtoLookupArm`, for two
 * reasons that pull in opposite directions and meet only here: the builder
 * needs every `<C>_<member>` function to be registered (they are not, while
 * function bodies are still being compiled — a read site is free to compile
 * before the class body), and `fillClassProtoLookupArm` needs the builder's
 * NAME in `funcMap` (the funcIdx is re-resolved there, since it is
 * shift-maintained).
 *
 * The body is `emitLazyProtoGet` + `drop` — the SAME emission a source-level
 * `C.prototype` read produces, deliberately, so a program that force-builds
 * through this path and one that touched `C.prototype` first end up with the
 * one identical singleton (`c.m === C.prototype.m`, §15.7.14).
 */
export function mintStandaloneClassProtoBuilders(ctx: CodegenContext): void {
  if (!(ctx.standalone || ctx.wasi)) return;
  // (#5383 S2h) A module compiled as a linked PROVIDER for a wasm consumer has
  // no read site of its own to record the demand — the read happens in the
  // OTHER module, and reaches this one through the S2d boundary terminal
  // (`__js2wasm_link_member_get`, which is a thin wrapper over this module's
  // `__extern_get`). So the provider cannot know which key will be asked, for
  // exactly the reason the terminals exist at all, and every class it owns has
  // to be reachable. Measured before this seed: `d.day` on a provider-owned
  // instance answered `undefined` across the boundary while the identical read
  // inside one module answered 2024, because the provider's own `__extern_get`
  // had no widened arm to delegate through.
  if (ctx.exportsConsumedByWasm === true) {
    for (const className of ctx.classSet) ctx.standaloneRuntimeKeyClassProtos.add(className);
  }
  if (ctx.standaloneRuntimeKeyClassProtos.size === 0) return;
  const voidTypeIdx = addFuncType(ctx, [], [], "$class_proto_build_type");
  for (const className of [...ctx.standaloneRuntimeKeyClassProtos].sort()) {
    const name = classProtoBuilderName(className);
    if (ctx.funcMap.has(name)) continue;
    if (!standaloneClassProtoObjectApplies(ctx, className)) continue;
    // A synthetic context so `emitLazyProtoGet` — which appends to `fctx.body`
    // and may allocate locals — can run outside any user function. Same shape
    // as `module-namespace-value.ts`'s minted namespace getter.
    const builderFctx: FunctionContext = {
      name,
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
    if (!emitLazyProtoGet(ctx, builderFctx, className)) continue;
    builderFctx.body.push({ op: "drop" });
    const funcIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, funcIdx, {
      name,
      typeIdx: voidTypeIdx,
      locals: builderFctx.locals,
      body: builderFctx.body,
      exported: false,
    });
    ctx.funcMap.set(name, funcIdx);
  }
}
