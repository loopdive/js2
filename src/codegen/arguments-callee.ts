// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4243) `arguments.callee` as a REAL own property of the arguments object,
 * for `--target standalone`.
 *
 * ## What was missing
 * The standalone arguments object is a `__vec_externref` struct built by
 * `emitArgumentsVecBody` — elements plus `length`, and nothing else. ES5 §10.6
 * step 13.a additionally creates
 *
 *     callee: { value: func, writable: true, enumerable: false, configurable: true }
 *
 * on every non-strict arguments object. Because that step was never emitted,
 * `arguments.callee` answered `undefined`, `arguments.hasOwnProperty("callee")`
 * was `false`, and `Object.getOwnPropertyDescriptor(arguments, "callee")` was
 * `undefined` — the whole `language/arguments-object` `callee` cluster.
 *
 * ## Why a define, not a bag write
 * The #3537 vec expando bag (`__vec_prop_set`) would make the READ work, but
 * `buildBagValueSeed` reflects every bag entry into the #3251 descriptor
 * companion with one fixed `SEED_FLAGS = 0xBF`, i.e. `enumerable: true`. `callee`
 * is specified non-enumerable, and `10.6-12-2` / `10.6-14-c-1-s` check exactly
 * that bit. Going through the same native `__defineProperty_value` that
 * `Object.defineProperty(arguments, "callee", …)` already lowers to in this lane
 * gets the descriptor right by construction, and reuses the array-exotic
 * [[DefineOwnProperty]] arm that landed with the WP1 descriptor work.
 *
 * ## Where the callee VALUE comes from
 * Deliberately supplied by the caller as a thunk, because the two arguments-object
 * construction sites have different — and equally canonical — answers:
 *
 *   * a hoisted function DECLARATION (`function-body.ts`) has no self param, so
 *     the callee is the cached closure singleton for its name — the same object
 *     an ordinary `f1` identifier read yields. That is what makes
 *     `arguments.callee === f1` (`S10.6_A4`) hold rather than merely being
 *     callable.
 *   * a lifted function EXPRESSION (`closures.ts`) already receives its own
 *     closure struct as `__self` at local 0. That IS the function object the
 *     caller invoked, so identity is free.
 *
 * The thunk is compiled into a detached scratch body first: if it cannot produce
 * a value (no closure singleton available — synthetic-name collisions, exotic
 * shapes) the whole seed is abandoned with `fctx.body` untouched, rather than
 * stranding a half-built argument list on the stack. `savedBody` is registered in
 * `ctx.liveBodies` across the swap per the #2182 discipline, since the thunk can
 * mint trampolines and add late imports.
 *
 * ## Strict mode is NOT handled here
 * §10.6 step 14 gives a strict arguments object a `callee` ACCESSOR whose get and
 * set are both %ThrowTypeError%. Minting that in-module needs a callable throwing
 * function value, which this module does not build; the strict half is covered
 * syntactically instead (`arguments-callee-poison.ts`), which is enough for a
 * direct `arguments.callee` read inside a strict function but not for a
 * descriptor query on an arguments object that has escaped its function. See
 * #4243 for the split and what it leaves on the table.
 *
 * ## Byte-neutrality
 * Gated on `noJsHost(ctx)`. The gc/host lane registers its arguments vecs with
 * the `__register_arguments` host import (#2743) and resolves `callee` there, so
 * host output is unchanged.
 */
import type { Instr, ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";
import { seedStrictArgumentsCalleePoison } from "./arguments-callee-poison-accessor.js"; // (#4555) §10.6 step 14
// Imported from the trampoline module directly, not the `closures.ts` barrel:
// `closures.ts` imports THIS module for its own function-expression seed, and
// going through the barrel would close that cycle. `expressions/new-super.ts`
// reaches the same helper the same way.
import { emitCachedFuncClosureExternref } from "./closures/method-trampolines.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { shouldRegisterArgumentsWithHost } from "./helpers/arguments-registration.js";
import { isStrictFunction } from "./helpers/is-strict-function.js";
import { noJsHost } from "./js-errors.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { addStringConstantGlobal } from "./registry/imports.js";

/**
 * §10.6 step 13.a attributes — `{writable: true, enumerable: false,
 * configurable: true}` in the HOST flag encoding `__defineProperty_value`
 * decodes (bits 0/1/2 are the writable/enumerable/configurable VALUES; bit 1
 * left clear ⇒ non-enumerable). Same constant `class-proto-object.ts` uses for
 * §17 method attributes, which happen to coincide.
 */
const CALLEE_FLAGS = 0x01 | 0x04;

/**
 * Install `callee` on the just-built arguments vec held in `argsLocalIdx`.
 *
 * @param pushCallee emits the function-object value and returns its ValType, or
 *   `null` to abandon the seed. Called with a detached `fctx.body`.
 */
export function seedArgumentsCallee(
  ctx: CodegenContext,
  fctx: FunctionContext,
  argsLocalIdx: number,
  pushCallee: () => ValType | null,
): void {
  if (!noJsHost(ctx)) return;
  ensureObjectRuntime(ctx);
  const defineIdx = ctx.funcMap.get("__defineProperty_value");
  if (defineIdx === undefined) return;

  const savedBody = fctx.body;
  const scratch: Instr[] = [];
  fctx.body = scratch;
  ctx.liveBodies.add(savedBody);
  let calleeType: ValType | null = null;
  try {
    calleeType = pushCallee();
  } finally {
    fctx.body = savedBody;
    ctx.liveBodies.delete(savedBody);
  }
  if (calleeType === null) return;

  fctx.body.push({ op: "local.get", index: argsLocalIdx });
  fctx.body.push({ op: "extern.convert_any" });
  addStringConstantGlobal(ctx, "callee");
  for (const instr of stringConstantExternrefInstrs(ctx, "callee")) fctx.body.push(instr);
  for (const instr of scratch) fctx.body.push(instr);
  if (calleeType.kind !== "externref") fctx.body.push({ op: "extern.convert_any" });
  fctx.body.push({ op: "f64.const", value: CALLEE_FLAGS });
  fctx.body.push({ op: "call", funcIdx: defineIdx });
  fctx.body.push({ op: "drop" });
}

/**
 * Declaration-site seed: `callee` is the SAME cached closure singleton an
 * ordinary `f1` identifier read yields.
 *
 * ## Two things are load-bearing here, both learned the hard way
 *
 * **1. It reads the cache global as an externref rather than as a struct.**
 * `ensureFuncClosureSingleton` memoizes the trampoline + cache global by NAME
 * but recomputes `closureStructTypeIdx` from the `constructible` flag on every
 * call, and the constructible wrapper is a *subtype* of the plain one. Two
 * callers that disagree about the flag therefore share one cache and disagree
 * about the struct, and the mismatch is asymmetric: casting a stored
 * constructible wrapper to the base type succeeds, casting a stored base
 * wrapper to the constructible type traps. The first cut of this seed used
 * `emitCachedFuncClosureAccess` and killed two `language/arguments-object`
 * tests that had been passing (`10.6-6-2`, `10.6-11-b-1`) with
 * `RuntimeError: illegal cast` inside the very function it was added to,
 * because a module-init binding seed had stored the base wrapper first.
 * `emitCachedFuncClosureExternref` skips the cast entirely — and the seed has
 * no use for the struct view, since the value goes straight into a descriptor.
 *
 * **2. The guard set mirrors the identifier read** in
 * `expressions/identifiers.ts`, and the two must stay in lockstep:
 *
 *   * `funcIdx >= numImportFuncs` — an import has no body to wrap.
 *   * not in `ctx.classSet` — class names take the class-object route.
 *   * NO captures — the module-init-time singleton cannot carry per-activation
 *     captures, so a capturing function takes the per-site
 *     `emitFuncRefAsClosure` path in the identifier read. Rather than mint a
 *     second, differently-shaped closure here, decline: `arguments.callee` then
 *     keeps its pre-#4243 `undefined`, which is a miss, not a wrong answer.
 *   * `constructible` = the same `isOrdinaryFunctionDecl` predicate (plain,
 *     non-generator, non-async declaration in a host-free lane). Passing the
 *     WIDER flavor is also the safe direction for the STORE, per (1).
 */
export function seedDeclarationArgumentsCallee(
  ctx: CodegenContext,
  fctx: FunctionContext,
  decl: ts.FunctionDeclaration,
  funcName: string,
  argsLocalIdx: number,
): void {
  // (#4555) §10.6 step 14 gives a STRICT arguments object a poison ACCESSOR
  // instead of this data property. (`arguments-callee-poison.ts` covers only a
  // direct syntactic read; the accessor is what a descriptor query, a
  // `hasOwnProperty`, or a write on an escaped arguments object observes.)
  if (isStrictFunction(decl, ctx.inferModuleStrictArguments)) {
    // (#4578) The poison accessor is observable only when the arguments object
    // itself is observable. Reuse the same conservative proof that guards
    // private host-registration elision: `.length` and checker-proven numeric
    // indexed reads stay entirely inside the vec representation, while eval,
    // escape, reflection, mutation, receiver use, and ambiguous keys all keep
    // the eager accessor. This removes a full object-runtime descriptor insert
    // from every hot call in strict ESM packages such as clsx and Acorn.
    if (decl.body && !shouldRegisterArgumentsWithHost(ctx, decl.body, fctx.directEvalBindingNames !== undefined)) {
      return;
    }
    seedStrictArgumentsCalleePoison(ctx, fctx, argsLocalIdx);
    return;
  }
  if (ctx.classSet.has(funcName)) return;
  const captures = ctx.nestedFuncCaptures.get(funcName);
  if (captures && captures.length > 0) return;
  const funcIdx = ctx.funcMap.get(funcName);
  if (funcIdx === undefined || funcIdx < ctx.numImportFuncs) return;
  const constructible =
    noJsHost(ctx) &&
    ts.isFunctionDeclaration(decl) &&
    decl.asteriskToken === undefined &&
    !(decl.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false);
  seedArgumentsCallee(ctx, fctx, argsLocalIdx, () =>
    emitCachedFuncClosureExternref(ctx, fctx, funcName, funcIdx, constructible)
      ? ({ kind: "externref" } as const)
      : null,
  );
}

/**
 * Lifted-function-expression seed: `callee` is `__self`, local 0.
 *
 * A lifted closure receives its own closure struct as its first parameter, and
 * that struct IS the function object the caller invoked — so this site needs no
 * singleton lookup, no cache global, and no cast, and the identity
 * `f2 === f2()` (`S10.6_A4` #2) holds for free.
 *
 * `arrow` is the source function-like node; arrows are excluded by the caller
 * (they inherit the enclosing function's `arguments` rather than binding their
 * own), so in practice this only sees function expressions.
 */
export function seedLiftedClosureArgumentsCallee(
  ctx: CodegenContext,
  liftedFctx: FunctionContext,
  arrow: ts.FunctionLikeDeclaration,
  argsLocalIdx: number,
): void {
  if (isStrictFunction(arrow, ctx.inferModuleStrictArguments)) {
    if (
      arrow.body &&
      !shouldRegisterArgumentsWithHost(ctx, arrow.body, liftedFctx.directEvalBindingNames !== undefined)
    ) {
      return;
    }
    seedStrictArgumentsCalleePoison(ctx, liftedFctx, argsLocalIdx); // (#4555) §10.6 step 14
    return;
  }
  const selfType = liftedFctx.params[0]?.type ?? null;
  if (selfType === null) return;
  seedArgumentsCallee(ctx, liftedFctx, argsLocalIdx, () => {
    liftedFctx.body.push({ op: "local.get", index: 0 });
    return selfType;
  });
}
