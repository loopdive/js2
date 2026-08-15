// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4456) Lexical scoping for the BARE-NAME function namespaces.
//
// ## The bug this exists to fix
//
// `ctx.funcMap` — and the ~dozen side tables keyed alongside it
// (`nestedFuncCaptures`, `closureMap`, `functionNameMap`, `funcRestParams`, …)
// — map a BARE function name to ONE physical Wasm function, module-wide and
// permanently. A nested `function` declaration is a *lexically scoped*
// binding, so two of them in different enclosing scopes are two different
// functions that happen to share a name:
//
//     function P() { function inner() { return 1; } return inner; }
//     function Q() { function inner() { return 2; } return inner; }
//
// The hoist gate in `nested-declarations.ts` skips a declaration whose name is
// already in `funcMap`, so `Q`'s `inner` was NEVER COMPILED: exactly one
// `$inner` reached the module and `Q` returned `P`'s function. Measured on the
// base revision, `P() === Q()` and `Q()() === 1` — the wrong body runs. This
// is R8 of #4437, split out because it is a correctness bug well beyond the
// own-property metadata that surfaced it.
//
// Both halves of that symptom are the SAME defect, and it is worth being
// precise about which: the closure-value identity (`p === q`) is downstream
// noise, and the wrong body (`q() === 1`) is the actual damage. #4437's note
// suspected the closure MINT keying (`nestedFnClosureArtifacts` /
// `__fn_closure_<name>`). It is not that — `ensureFuncClosureSingleton` has
// disambiguated by call TARGET since #4133, and disassembling the base module
// shows a single `(func $inner …)` with a single `$__fn_tramp_inner_cached`.
// There is only one closure because there is only one function. Fixing the
// mint keying alone would have produced two distinct closure values that both
// called the same body — a more convincing wrong answer, not a right one.
//
// ## Why the capturing case looked fine
//
// A capturing nested function receives its captures as LEADING PARAMETERS, so
// `P`/`Q` above with `var a` in each frame produce one `$inner (param a)` that
// is handed 1 or 2 by the respective activation. The bodies coincide *modulo
// the capture*, so the aliasing is invisible. Give the two declarations
// genuinely different bodies and the capturing shape fails identically — which
// is why the probe matrix in the issue file uses distinguishable bodies
// throughout, and why "case B passes" must not be read as "captures are safe".
//
// ## The fix: shadow, then restore
//
// A nested declaration's binding is live exactly for its enclosing body. So
// when a body's hoist registers a name that is ALREADY owned by some other
// declaration, we push the previous registration onto a shadow stack, free the
// name so this declaration compiles its own function, and pop the stack when
// the enclosing body's compilation finishes. That is ordinary lexical scoping
// applied to a namespace that never had any.
//
// ### Why restore, rather than leave the last writer in place
//
// Leaving the shadow in place is tempting (one write site, no callers to
// touch) and it is wrong in a way the probes catch:
//
//     function inner() { return 5; }                       // top level
//     function B() { function inner() { return 7; } … }    // shadows it
//     …
//     inner();   // ← must still reach the TOP-LEVEL inner
//
// Without the restore, `B`'s hoist leaves `funcMap.inner` pointing at `B`'s
// function and the later top-level call silently retargets. That trades one
// wrong answer for another. The same applies one scope in (`Outer` declaring
// both `inner` and `Mid`, where `Mid` re-declares `inner`): after `Mid`
// compiles, `Outer`'s own `inner()` must still be `Outer`'s.
//
// The read-side alternative — keep every shadow and have call sites pick the
// lexically visible candidate — was considered and rejected as the primary
// mechanism: the visibility predicate exists in exactly ONE reader today
// (`call-identifier.ts`'s `isOutOfScopeNestedBinding`, #4133), so it would
// have to be grown into every reader of a bare function name, and a reader
// that forgot it would keep the old wrong answer with no signal. Restoring at
// the body boundary makes the invariant hold for readers that know nothing
// about scoping, which is all of them.
//
// ### What is deliberately NOT in the saved family
//
// `ctx.funcClosureGlobals` / the `__fn_tramp_<name>_cached` pair are NOT saved
// or freed. `ensureFuncClosureSingleton` already resolves those per call
// TARGET, walking `<name>$1`, `<name>$2`, … until it finds a free slot or one
// that already points at this exact function (#4133). Freeing the cache global
// while leaving the trampoline registered in `funcMap` would present that
// helper with a HALF-registered pair, which it correctly refuses (returning
// `null`), turning a working closure read into a declined one. The existing
// disambiguator is the right owner of that namespace; this module must not
// race it.
//
// ### Failure mode if a caller forgets to close its scope
//
// Degraded to the pre-#4456 behaviour for names in that body (last writer
// wins), not a crash and not an invalid module: the entries stay in `funcMap`
// pointing at real, fully-compiled functions. That is the intended safety
// property of a marker-based stack — partial adoption is sound.
import type ts from "typescript";
import type { CodegenContext } from "./context/types.js";

/**
 * One shadowed bare-name registration, captured across every side table that
 * is keyed by a bare function name.
 *
 * `has*` is stored separately from the value because `undefined` is a legal
 * stored value for some of these maps, and because a name may be present in
 * one table and absent from another (a bodyless reservation has a `funcMap`
 * entry and no captures, for instance).
 */
interface ShadowedFuncBinding {
  name: string;
  hadFunc: boolean;
  func: number | undefined;
  hadOwner: boolean;
  owner: ts.FunctionDeclaration | undefined;
  hadCaptures: boolean;
  captures: ReturnType<CodegenContext["nestedFuncCaptures"]["get"]>;
  hadOptional: boolean;
  optional: ReturnType<CodegenContext["funcOptionalParams"]["get"]>;
  hadRest: boolean;
  rest: ReturnType<CodegenContext["funcRestParams"]["get"]>;
  hadClosure: boolean;
  closure: ReturnType<CodegenContext["closureMap"]["get"]>;
  hadFunctionName: boolean;
  functionName: ReturnType<CodegenContext["functionNameMap"]["get"]>;
  hadNestedArtifacts: boolean;
  nestedArtifacts: { structTypeIdx: number; trampolineName: string } | undefined;
  usedArguments: boolean;
  wasAsync: boolean;
  wasGenerator: boolean;
  wasPreRegistered: boolean;
  hoistFailed: boolean;
}

/**
 * Per-context shadow stack, newest last.
 *
 * Deliberately a module-private `WeakMap` rather than a `CodegenContext` field:
 * nothing outside this module may read or write it, and `context/types.ts` is a
 * 3.8k-line god-file under an LOC budget (#3102) that a subsystem's private
 * state has no business growing. The lookup runs once per function-like body,
 * which is nowhere near a hot path.
 */
const shadowStacks = new WeakMap<CodegenContext, ShadowedFuncBinding[]>();

function stackFor(ctx: CodegenContext): ShadowedFuncBinding[] {
  let stack = shadowStacks.get(ctx);
  if (!stack) {
    stack = [];
    shadowStacks.set(ctx, stack);
  }
  return stack;
}

/** Opaque marker for a body scope; the depth of the shadow stack at entry. */
export type NestedFunctionNameScope = number;

/**
 * Should compiling `decl` shadow the existing bare-name registration?
 *
 * True when the name is live in `funcMap` under a DIFFERENT owner. Three
 * distinct "owners" are folded into that:
 *
 *  - another nested declaration (the #4456 case proper, incl. a genuine
 *    lexical shadow one scope in);
 *  - a top-level declaration or import, which has no `funcMapOwnerDecl` record
 *    (#4133's convention) — a nested declaration shadows those too;
 *  - a bodyless reservation or re-hoist of THIS declaration, where the owner
 *    IS `decl` and nothing must move.
 *
 * The compiler's own synthesized helpers all carry a `__` prefix and are
 * excluded, so a user declaration can never displace `__box_number` and
 * friends out from under an in-flight emission.
 */
export function nestedFuncDeclNeedsShadow(
  ctx: CodegenContext,
  decl: ts.FunctionDeclaration,
  funcName: string,
): boolean {
  if (!ctx.funcMap.has(funcName)) return false;
  if (ctx.funcMapOwnerDecl.get(funcName) === decl) return false;
  if (funcName.startsWith("__")) return false;
  return true;
}

/**
 * Open a body scope. Cheap (an integer read) — safe to call unconditionally at
 * every function-like body compile, including bodies with no declarations.
 */
export function beginNestedFunctionNameScope(ctx: CodegenContext): NestedFunctionNameScope {
  return shadowStacks.get(ctx)?.length ?? 0;
}

/**
 * Free `funcName` for a fresh compile of `decl`, recording what was there so
 * {@link endNestedFunctionNameScope} can put it back.
 *
 * Callers must have checked {@link nestedFuncDeclNeedsShadow} first; this
 * records unconditionally so that the paired pop is always balanced.
 */
export function shadowNestedFuncName(ctx: CodegenContext, funcName: string): void {
  stackFor(ctx).push({
    name: funcName,
    hadFunc: ctx.funcMap.has(funcName),
    func: ctx.funcMap.get(funcName),
    hadOwner: ctx.funcMapOwnerDecl.has(funcName),
    owner: ctx.funcMapOwnerDecl.get(funcName),
    hadCaptures: ctx.nestedFuncCaptures.has(funcName),
    captures: ctx.nestedFuncCaptures.get(funcName),
    hadOptional: ctx.funcOptionalParams.has(funcName),
    optional: ctx.funcOptionalParams.get(funcName),
    hadRest: ctx.funcRestParams.has(funcName),
    rest: ctx.funcRestParams.get(funcName),
    hadClosure: ctx.closureMap.has(funcName),
    closure: ctx.closureMap.get(funcName),
    hadFunctionName: ctx.functionNameMap.has(funcName),
    functionName: ctx.functionNameMap.get(funcName),
    hadNestedArtifacts: ctx.nestedFnClosureArtifacts?.has(funcName) ?? false,
    nestedArtifacts: ctx.nestedFnClosureArtifacts?.get(funcName),
    usedArguments: ctx.funcUsesArguments.has(funcName),
    wasAsync: ctx.asyncFunctions.has(funcName),
    wasGenerator: ctx.generatorFunctions.has(funcName),
    wasPreRegistered: ctx.preRegisteredBodyless?.has(funcName) ?? false,
    hoistFailed: ctx.hoistFailedFuncs?.has(funcName) ?? false,
  });

  ctx.funcMap.delete(funcName);
  ctx.funcMapOwnerDecl.delete(funcName);
  ctx.nestedFuncCaptures.delete(funcName);
  ctx.funcOptionalParams.delete(funcName);
  ctx.funcRestParams.delete(funcName);
  ctx.closureMap.delete(funcName);
  ctx.functionNameMap.delete(funcName);
  // The struct type + trampoline minted for a capturing nested function are
  // per-DECLARATION artifacts cached under the bare name (#2976). Reusing the
  // outer declaration's pair for this one would hand the new function the old
  // one's capture layout.
  ctx.nestedFnClosureArtifacts?.delete(funcName);
  ctx.funcUsesArguments.delete(funcName);
  ctx.asyncFunctions.delete(funcName);
  ctx.generatorFunctions.delete(funcName);
  ctx.preRegisteredBodyless?.delete(funcName);
  ctx.hoistFailedFuncs?.delete(funcName);
}

/**
 * Close a body scope, restoring every registration shadowed since `scope`.
 *
 * Unwinds in REVERSE push order: one body may shadow the same name more than
 * once (a re-hoist through the block/loop recursion), and only last-in-first-
 * out restores the original.
 *
 * Note what is NOT undone: the functions compiled under the shadowed name stay
 * in `ctx.mod.functions` at their assigned indices, and every reference to
 * them was resolved to a raw index while the shadow was live. Restoring only
 * moves NAMES, never indices, so this cannot perturb `addUnionImports`' late
 * import shift or any emitted `call`.
 */
export function endNestedFunctionNameScope(ctx: CodegenContext, scope: NestedFunctionNameScope): void {
  const stack = shadowStacks.get(ctx);
  if (!stack) return;
  while (stack.length > scope) {
    const saved = stack.pop()!;
    const { name } = saved;
    restore(ctx.funcMap, name, saved.hadFunc, saved.func);
    restore(ctx.funcMapOwnerDecl, name, saved.hadOwner, saved.owner);
    restore(ctx.nestedFuncCaptures, name, saved.hadCaptures, saved.captures);
    restore(ctx.funcOptionalParams, name, saved.hadOptional, saved.optional);
    restore(ctx.funcRestParams, name, saved.hadRest, saved.rest);
    restore(ctx.closureMap, name, saved.hadClosure, saved.closure);
    restore(ctx.functionNameMap, name, saved.hadFunctionName, saved.functionName);
    if (saved.hadNestedArtifacts) (ctx.nestedFnClosureArtifacts ??= new Map()).set(name, saved.nestedArtifacts!);
    else ctx.nestedFnClosureArtifacts?.delete(name);
    toggle(ctx.funcUsesArguments, name, saved.usedArguments);
    toggle(ctx.asyncFunctions, name, saved.wasAsync);
    toggle(ctx.generatorFunctions, name, saved.wasGenerator);
    if (saved.wasPreRegistered) (ctx.preRegisteredBodyless ??= new Set()).add(name);
    else ctx.preRegisteredBodyless?.delete(name);
    if (saved.hoistFailed) (ctx.hoistFailedFuncs ??= new Set()).add(name);
    else ctx.hoistFailedFuncs?.delete(name);
  }
}

function restore<K, V>(map: Map<K, V>, key: K, had: boolean, value: V | undefined): void {
  if (had) map.set(key, value as V);
  else map.delete(key);
}

function toggle<K>(set: Set<K>, key: K, present: boolean): void {
  if (present) set.add(key);
  else set.delete(key);
}
