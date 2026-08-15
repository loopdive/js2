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
import { ts } from "../ts-api.js"; // value import: the scope walk needs the `is*` predicates
import type { CodegenContext } from "./context/types.js";
import { EVAL_SOURCE_FILENAME } from "./expressions/eval-source.js";

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

function isFunctionLikeScope(n: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n)
  );
}

/**
 * The FRAME `node` is hoisted into: the nearest enclosing function-like node,
 * or the `SourceFile` at top level. `undefined` means UNDETERMINABLE — the
 * parent chain ran out without reaching either, which a synthesized node can
 * do — and callers must decline rather than guess.
 *
 * A function declaration is hoisted to its enclosing FUNCTION, not its
 * enclosing block (Annex B §B.3.3), so the block chain is deliberately walked
 * through. Same walk as `call-identifier.ts`'s `isOutOfScopeNestedBinding` and
 * `transitiveVisibleDeclarationCaptures`; kept in step with them on purpose.
 *
 * Returning the `SourceFile` rather than `undefined` for top level is
 * load-bearing (#4586): eval'd code is re-parsed into its own `SourceFile`, and
 * conflating "top level" with "undeterminable" made every eval-lane pair look
 * undeterminable and decline — which is what re-broke the 24-file
 * `eval-…-existing-fn-no-init` family.
 */
function enclosingFunctionScope(node: ts.Node): ts.Node | undefined {
  for (let p: ts.Node | undefined = node.parent; p !== undefined; p = p.parent) {
    if (isFunctionLikeScope(p)) return p;
    if (ts.isSourceFile(p)) return p;
  }
  return undefined;
}

/**
 * Do `a` and `b` denote the same runtime FRAME?
 *
 * Node identity is the answer everywhere except the eval lane, where it is
 * wrong in a way that costs a compile error (#4586). Every direct/indirect
 * `eval` is parsed into its OWN synthetic `SourceFile` — measured: four
 * `eval('function err(){}')` calls in one catch block produce four distinct
 * `<eval>.ts` nodes — but the declarations they contain are reified into the
 * HOST frame, not into a frame of their own. So two eval `SourceFile`s are
 * never *evidence* of different frames, and treating them as such shadowed a
 * registration nothing would restore:
 * `annexB/…/var-env-lower-lex-catch-non-strict.js` went straight back to
 * `absoluteFuncIndex: unresolved call target (funcIdx=undefined)`.
 *
 * Deliberately conservative rather than exact: two evals in genuinely
 * different host frames are also read as same-frame, so a cross-frame alias
 * introduced through two separate evals stays unfixed. That is the pre-#4456
 * lowering — absent-not-wrong — and it is the safe direction, since the
 * failure mode in the other direction is an invalid module.
 */
function sameFrame(a: ts.Node, b: ts.Node): boolean {
  if (a === b) return true;
  return isEvalSourceFile(a) && isEvalSourceFile(b);
}

function isEvalSourceFile(n: ts.Node): boolean {
  return ts.isSourceFile(n) && n.fileName === EVAL_SOURCE_FILENAME;
}

/**
 * Is `decl` declared at the TOP of its frame — i.e. directly in the frame's
 * statement list rather than inside a `Block` / `CaseClause` / `DefaultClause`
 * within it?
 *
 * This is the Annex B distinction that matters at HOIST time. A top-of-frame
 * declaration is installed by ordinary FunctionDeclarationInstantiation /
 * EvalDeclarationInstantiation and owns the name from the first statement
 * onward; a block-level one is a §B.3.3 web-compat candidate that only assigns
 * the var-scoped binding **when its block is evaluated**.
 */
function isTopOfFrameDeclaration(decl: ts.FunctionDeclaration): boolean {
  const parent: ts.Node | undefined = decl.parent;
  if (parent === undefined) return false;
  if (ts.isSourceFile(parent) || ts.isModuleBlock(parent)) return true;
  // A function's own body block IS the top of that frame; any other block is a
  // nested statement list and therefore §B.3.3 territory.
  if (ts.isBlock(parent)) {
    const owner: ts.Node | undefined = parent.parent;
    return owner !== undefined && isFunctionLikeScope(owner);
  }
  return false;
}

/**
 * Should compiling `decl` shadow the existing bare-name registration?
 *
 * ## Three-way, and every branch is paid for by a measured regression
 *
 * #4456's own defect is **cross-FRAME** aliasing: two declarations in two
 * different function activations collapsing onto one physical function. The
 * first cut fired the shadow for *any* other owner, which was too broad; the
 * second cut declined for the whole same-frame case, which was too narrow and
 * cost 24 test262 files. Both were caught only by the `merge_group`
 * re-validation, never at PR level.
 *
 * The predicate is therefore three-way, and the branches are not interchangeable
 * — each was measured against the reproduction that forces it (2026-08-15):
 *
 * | reproduction                                          | needs           |
 * | ----------------------------------------------------- | --------------- |
 * | `P(){function inner(){5}}` + `Q(){function inner(){7}}` | cross-frame ⇒ SHADOW |
 * | 24× `annexB/…/eval-{func,global}-existing-fn-no-init`  | top-of-frame newcomer ⇒ SHADOW |
 * | `annexB/…/block-decl-nested-blocks-with-fun-decl`      | block-vs-block ⇒ DECLINE |
 * | `annexB/…/var-env-lower-lex-catch-non-strict` (CE)     | eval frames merged + directional rule ⇒ DECLINE |
 * | `function err(){}` + `eval('async function* err(){}')` (CE) | owner clause ⇒ DECLINE |
 *
 * ### Different frames ⇒ shadow
 *
 * The #4456 case proper. Nothing subtle: two activations, two bindings, two
 * physical functions. See {@link sameFrame} for why frame identity is not just
 * node identity in the eval lane.
 *
 * ### Same frame ⇒ only a TOP-OF-FRAME newcomer may displace a BLOCK-level one
 *
 * This is Annex B §B.3.3 hoist order, and it is DIRECTIONAL. A top-of-frame
 * declaration is installed by ordinary FunctionDeclarationInstantiation /
 * EvalDeclarationInstantiation and owns the name from the first statement
 * onward. A block-level declaration is a §B.3.3 web-compat candidate that
 * assigns the var-scoped binding only **when its block is evaluated**. So the
 * top-of-frame one must win *at hoist*, whichever order the two are seen in:
 *
 *  - block hoisted first, top-of-frame second ⇒ SHADOW, so the top-of-frame
 *    declaration takes the name back;
 *  - top-of-frame first, block second ⇒ DECLINE, and the pre-existing
 *    "already registered, skip" gate leaves the top-of-frame one in place.
 *
 * The 24-file `eval-…-existing-fn-no-init` family is exactly this, and it is
 * the *first* order: measured, the block declaration is hoisted first and the
 * top-of-frame declaration arrives as the newcomer. Each of those tests reads
 * the binding (`init = f`) BEFORE the block runs and asserts it is the
 * top-of-frame function; declining there returned `"inner declaration"`.
 *
 * Both sides block-level ⇒ DECLINE, and that is the other regression:
 * `block-decl-nested-blocks-with-fun-decl.js` has no top-of-frame declaration
 * at all, so §B.3.3's own applicability machinery (`annexb-cancel.ts`) owns the
 * answer and this gate must not interfere. Note that test is the
 * Annex-B-INAPPLICABLE variant; for *applicable* sibling blocks B.3.3 rebinds
 * at each declaration's evaluation, so last-executed-wins is equally correct
 * and equally must not be "healed". Same decline, two different reasons.
 *
 * Both sides top-of-frame ⇒ DECLINE. There is no §B.3.3 question to answer, and
 * shadowing repeatedly in one frame is what produced the `funcIdx=undefined`
 * compile error on `var-env-lower-lex-catch-non-strict.js` (four eval'd `err`
 * declarations reified into one catch block).
 *
 * ### The owner clause — never displace an OWNER-LESS registration
 *
 * Applied before either of the above. The incumbent must have a
 * `funcMapOwnerDecl` record, i.e. be a nested declaration. Absent ⇒ the name
 * belongs to a top-level declaration, an import or a synthesized helper
 * (#4133's convention), and shadowing it deletes a registration no scope on the
 * stack will put back — an independent route to the same CE, smallest
 * reproduction in the table, and NOT reachable by the frame rules, since an
 * incumbent with no owner record has no computable scope to compare.
 *
 * Consequence, accepted deliberately: a nested declaration shadowing a
 * same-named TOP-LEVEL one stays unfixed. It costs nothing observable — that
 * shape returned the wrong answer on the first cut too (the IR front-end's
 * bare-name direct-call plan called the top-level unit even though both
 * functions were emitted), so it was already a pinned `it.fails` residual in
 * `tests/issue-4456.test.ts`. Its real owner is that call-binding resolution,
 * not this gate.
 *
 * An UNDETERMINABLE scope on either side declines rather than guessing:
 * a synthesized declaration can carry a detached parent chain.
 *
 * `__`-prefixed names stay excluded so a user declaration can never displace
 * `__box_number` and friends out from under an in-flight emission.
 */
export function nestedFuncDeclNeedsShadow(
  ctx: CodegenContext,
  decl: ts.FunctionDeclaration,
  funcName: string,
): boolean {
  if (!ctx.funcMap.has(funcName)) return false;
  if (funcName.startsWith("__")) return false;

  const incumbent = ctx.funcMapOwnerDecl.get(funcName);
  if (incumbent === undefined || incumbent === decl) return false;

  const incumbentScope = enclosingFunctionScope(incumbent);
  const declScope = enclosingFunctionScope(decl);
  // Undeterminable on either side: decline rather than guess.
  if (incumbentScope === undefined || declScope === undefined) return false;

  // Different frames — the #4456 case proper. Two activations, two bindings,
  // two physical functions.
  if (!sameFrame(incumbentScope, declScope)) return true;

  // Same frame. The ONLY displacement allowed here is a top-of-frame
  // declaration taking the name back from a block-level one, and it is
  // directional on purpose (see the doc comment above).
  return isTopOfFrameDeclaration(decl) && !isTopOfFrameDeclaration(incumbent);
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
