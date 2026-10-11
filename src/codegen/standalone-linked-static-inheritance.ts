// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// standalone-linked-static-inheritance.ts — (#6644, #5383 S66) §15.7.14 step 6
// across the wasm→wasm link: `class S extends NS.Base {}` must make `S.from`
// resolve to the PROVIDER's static.
//
// ## The defect
//
// #6640/S64 gave such a class a real `super(...)` through the provider's own
// constructor, so its INSTANCES are provider-minted objects and every inherited
// instance read/call works by construction. The CLASS OBJECT got nothing: the
// consumer's `S` is an ordinary compiled class object with no [[Prototype]]
// edge to `NS.Base`, so a static the subclass does not itself declare resolves
// nowhere. Measured on the S65 head with the two-module fixture
// (`.tmp/s66/probes/p1.mts`) and, against the real `@js-temporal/polyfill`
// provider, in #6643's `.tmp/s65/probes/p24.js`:
//
// | expression | S65 head |
// | --- | --- |
// | `typeof Sub.from` | `undefined` |
// | `Sub.from(3).get()` | `!called value is not a function` |
// | `Sub.tag()` | `!called value is not a function` |
// | `Sub["tag"]()` | `null` |
// | `Object.getPrototypeOf(Sub) === NS.Base` | `false` |
//
// That is what `TemporalHelpers.checkThisValueNotCalled` — the third and last
// helper of `checkSubclassingIgnoredStatic` — stops on, and therefore what both
// `*/from/subclassing-ignored.js` rows stop on: it builds
// `class MySubclass extends construct {}` and immediately calls
// `MySubclass[method](...)`.
//
// ## The mechanism
//
// The forward link, evaluated where it is needed rather than cached: the
// heritage EXPRESSION recorded by #6640 (`ctx.classLinkedDynamicParentExpr`) is
// re-compiled at the consuming site and the member question is put to it
// through the ordinary `__extern_get`, whose peer `memberGet` arm (#5383 S2d)
// already answers for a provider-owned receiver.
//
// Re-compiling rather than caching in a module global is deliberate, and it is
// the same argument `emitLinkedDynamicParentConstruct` makes for the `super`
// site: the heritage of a LINKED class is a property access on an imported
// namespace binding (`NS.Base`, `Temporal.PlainDate`), so evaluating it is a
// pure read of a module-level binding — no user expression runs twice, and no
// lazily-initialised global has to be threaded through the #1984 index freeze.
// A heritage with observable side effects cannot reach here: the #6640 gate
// admits property/element ACCESS only.
//
// ## Scope
//
//  - The class must be in `ctx.classLinkedDynamicParentExpr` — i.e. it already
//    took #6640's path, which is standalone/WASI + a linked wasm provider +
//    a property/element-access heritage. Nothing here can reach a module with
//    no linked provider, which is the whole byte corpus.
//  - The member must not be one the class (or the local part of its own static
//    surface) already answers; every own arm in `emitClassStaticMemberRead`
//    runs first, and this is its last arm before `PA_FALLTHROUGH`.
//  - `prototype`, `name`, `length` and `constructor` are NOT routed: §15.7.14
//    gives a derived class its OWN `prototype` and `name`, and the local arms
//    that answer them are correct. Forwarding them would hand back the
//    PARENT's, which is a new wrong answer rather than a missing one.
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { emitToPropertyKeyOnce } from "./expressions/computed-member-reference.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureObjVecBuilders, reserveApplyClosure } from "./object-runtime.js";
import { tryEmitSpreadHostArgs } from "./host-method-args.js"; // (#5383 S67) runtime-length spread
import { hasSpreadArgument } from "./spread-arg-list.js";

import { allocLocal } from "./context/locals.js";
import { coerceType, compileExpression } from "./shared.js";
import { pushLinkedDynamicParent } from "./standalone-dynamic-parent-class.js"; // (#6644) captured identifier heritage
import { withSpeculativeCompile } from "./context/speculative.js"; // (#1919) transactional rollback

const EXTERNREF: ValType = { kind: "externref" };

/**
 * Own properties of a class object that a derived class gets for itself, and
 * that must therefore never be forwarded to the linked parent.
 */
const NOT_INHERITED = new Set(["prototype", "name", "length", "constructor"]);

/**
 * (#6644, #5383 S67) Resolve the class IDENTITY an identifier names, for the
 * linked-static arms only.
 *
 * `classExprNameMap.get(text) ?? text` — what the computed arm and the static
 * call ladder key on — is NAME-keyed, and a name is not an identity: #4618's
 * `mintScopedClassIdentity` gives every same-named class but the FIRST a
 * per-site synthetic (`__anonClass_S_4`), and #4646 mints it lazily for the
 * scopes the collection pass never walks (a class/object-literal METHOD body,
 * a sibling block). The bare name then resolves to a DIFFERENT declaration.
 *
 * For these arms that is not a precision nicety but a wrong answer, because a
 * captured IDENTIFIER heritage stores its parent in a per-class module global
 * (`__linked_parent_<C>`): keying on the name reads the twin's global. Measured
 * on the branch base with the two-module fixture (`.tmp/s67/probes/p31.mts`),
 * two same-named classes in two object-literal methods with DIFFERENT parents:
 *
 * | call | base |
 * | --- | --- |
 * | `oB.go(NS.Other, 'tag')` before the owner ever ran | `null` |
 * | `oA.go(NS.Base, 'tag')` (the owner) | `base` |
 * | `oB.go(NS.Other, 'tag')` after it | **`base`** — the WRONG parent |
 *
 * That third row is why the shape-sensitivity #6644's residual 1 recorded
 * looked contradictory across probes: an inherited static resolved whenever
 * some earlier call happened to have written the shared global with a
 * compatible value, and declined (`undefined`) otherwise. The trigger is the
 * NAME COLLISION and which declaration owns the bare name, not the enclosing
 * shape.
 *
 * Resolution is therefore by DECLARATION identity, through the oracle:
 *
 *  - a per-site synthetic (#4618) is the identity outright;
 *  - a declaration that OWNS its source name (`classDeclarationMap` maps the
 *    name back to this very node) keeps the name, resolved through
 *    `classExprNameMap` exactly as before;
 *  - a colliding twin with no synthetic MINTED YET is refused — the arms then
 *    emit nothing and the caller keeps today's behaviour, which is a miss
 *    rather than another class's parent.
 *
 * Anything that is not a compiled class declaration is not this arm's
 * receiver and is refused too.
 */
export function resolveLinkedStaticClassName(ctx: CodegenContext, identifier: ts.Identifier): string | undefined {
  // Cheap exact gate: with no linked-dynamic-parent class in the module there
  // is nothing for any caller to match, so no oracle query is worth paying for
  // (every element access on an identifier reaches here).
  if (ctx.classLinkedDynamicParentExpr.size === 0) return undefined;
  const decl = ctx.oracle.valueDeclarationOf(identifier);
  if (decl === undefined || (!ts.isClassDeclaration(decl) && !ts.isClassExpression(decl))) return undefined;
  const synthetic = ctx.anonClassExprNames.get(decl);
  if (synthetic !== undefined) return synthetic;
  const sourceName = decl.name?.text;
  if (sourceName === undefined) return undefined;
  const owner = ctx.classDeclarationMap.get(sourceName);
  if (owner !== undefined && owner !== decl) return undefined;
  return ctx.classExprNameMap.get(sourceName) ?? sourceName;
}

/**
 * The heritage expression `className` extends across the link, or `undefined`
 * when this class is not one of #6640's linked-dynamic-parent classes or
 * `propName` is a member a derived class owns outright.
 */
export function linkedStaticParentHeritage(
  ctx: CodegenContext,
  className: string,
  propName: string,
): ts.Expression | undefined {
  if (NOT_INHERITED.has(propName)) return undefined;
  return ctx.classLinkedDynamicParentExpr.get(className);
}

/**
 * Emit `__extern_get(<heritage value>, "<propName>")`, leaving one externref on
 * the stack.
 *
 * Returns false having emitted NOTHING when the heritage value could not be
 * compiled or `__extern_get` is unavailable — the caller then keeps whatever it
 * does today. `compileHeritage` is the caller's expression compiler (this leaf
 * must not import `shared.js`, which would close a cycle through the codegen
 * god-file); it must leave exactly one externref on the stack.
 */
export function emitLinkedStaticMemberRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  className: string,
  propName: string,
  compileHeritage: (expr: ts.Expression) => boolean,
): boolean {
  const externGetIdx = ensureLateImport(ctx, "__extern_get", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  if (externGetIdx === undefined) return false;
  flushLateImportShifts(ctx, fctx);
  // (#1919) A failed heritage compile rolls back locals and late imports too,
  // not just the body — this is a speculative lowering, not a truncation.
  return withSpeculativeCompile(ctx, fctx, () => {
    if (!pushLinkedDynamicParent(ctx, fctx, className, compileHeritage)) return { commit: false, value: false };
    fctx.body.push(...stringConstantExternrefInstrs(ctx, propName));
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__extern_get") ?? externGetIdx } satisfies Instr);
    return { commit: true, value: true };
  });
}

/**
 * (#6644) `S.m(a, b)` — the CALL form of the same inherited static.
 *
 * Not derivable from {@link emitLinkedStaticMemberRead} at the call site,
 * because the ordinary class-object call ladder never consults the member READ:
 * it resolves `<Class>_<method>` in `staticMethodSet`, walks `classParentMap`
 * (empty for a linked heritage — the parent is a runtime value, not a compiled
 * class) and, finding nothing, ends in the generic callee guard. Measured:
 * `Sub.tag()` threw `TypeError: called value is not a function` with the READ
 * arm already landed and `typeof Sub.from` already answering `"function"`.
 *
 * Lowering is `__apply_closure(__extern_get(P, "m"), P, [args…])` where `P` is
 * the parent class object. Both halves already cross the seam: the resolve is
 * the READ arm's, and `__apply_closure`'s #6420 peer arm hands a
 * provider-owned callee to the provider, which binds `this` through its OWN
 * `__current_this` — the global a consumer cannot write, and the reason the
 * whole call has to be shipped rather than the closure pulled across (#5383
 * S2h).
 *
 * **`this` is the PARENT class object, not `S` — a deliberate, documented
 * bound.** §15.7.14 would bind `S`; that value is a consumer-side `$S` struct
 * the provider cannot decode, so binding it would make a provider static that
 * reads `this` (`static from(x) { return new this(x) }`) fail outright rather
 * than answer. Binding the parent produces exactly the "subclassing is ignored"
 * result the Temporal `subclassing-ignored` rows assert, and every Temporal
 * static ignores `this` altogether. A provider static that genuinely
 * distinguishes its receiver is out of reach until the consumer's class object
 * can cross the boundary as a first-class value.
 */
function emitLinkedStaticMemberCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  className: string,
  member: { name: string } | { key: ts.Expression },
  args: readonly ts.Expression[],
  pushExtern: (expr: ts.Expression) => boolean,
): boolean {
  const externGetIdx = ensureLateImport(ctx, "__extern_get", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  if (externGetIdx === undefined) return false;
  const { newIdx, pushIdx } = ensureObjVecBuilders(ctx);
  const applyIdx = reserveApplyClosure(ctx);
  flushLateImportShifts(ctx, fctx);
  // (#1919) Transactional: a failed parent or argument compile rolls back the
  // locals allocated below along with the body.
  return withSpeculativeCompile(ctx, fctx, () => {
    // §13.3.6.1: the MemberExpression is evaluated and GetValue'd BEFORE the
    // arguments, so the parent read — and, for `S[k](…)`, the KEY — comes
    // first and is held in a local.
    const parentLocal = allocLocal(fctx, `__lsi_parent_${fctx.locals.length}`, EXTERNREF);
    const calleeLocal = allocLocal(fctx, `__lsi_callee_${fctx.locals.length}`, EXTERNREF);
    if (!pushLinkedDynamicParent(ctx, fctx, className, pushExtern)) return { commit: false, value: false };
    fctx.body.push({ op: "local.tee", index: parentLocal });
    if ("name" in member) {
      fctx.body.push(...stringConstantExternrefInstrs(ctx, member.name));
    } else {
      if (!pushExtern(member.key)) return { commit: false, value: false };
      emitToPropertyKeyOnce(ctx, fctx);
    }
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__extern_get") ?? externGetIdx } satisfies Instr);
    fctx.body.push({ op: "local.set", index: calleeLocal });

    const argsLocal = allocLocal(fctx, `__lsi_args_${fctx.locals.length}`, EXTERNREF);
    fctx.body.push({ op: "call", funcIdx: newIdx });
    fctx.body.push({ op: "local.set", index: argsLocal });
    // (#5383 S67) A SPREAD contributes its RUNTIME element count, so the
    // unrolled one-push-per-AST-node loop below is exact only without one:
    // `S[m](...a)` reached the provider's `from` with the argument vector
    // itself. `tryEmitSpreadHostArgs` is the single place in the compiler that
    // repairs that difference (#6616's shared builder); it emits nothing and
    // answers false when there is no spread, which is what keeps every
    // existing call site byte-identical.
    if (!tryEmitSpreadHostArgs(ctx, fctx, args, argsLocal, "__objvec_push", pushIdx)) {
      for (const arg of args) {
        fctx.body.push({ op: "local.get", index: argsLocal });
        if (!pushExtern(arg)) return { commit: false, value: false };
        fctx.body.push({ op: "call", funcIdx: pushIdx } satisfies Instr);
      }
    }
    fctx.body.push({ op: "local.get", index: calleeLocal });
    fctx.body.push({ op: "local.get", index: parentLocal });
    fctx.body.push({ op: "local.get", index: argsLocal });
    // Expanding a spread can register late imports, which shifts every
    // defined-function index captured before them — re-resolve by name.
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__apply_closure") ?? applyIdx });
    return { commit: true, value: true };
  });
}

/**
 * Compile one externref operand, or return false having left the body in a
 * state the caller is about to truncate.
 */
function pushExtern(ctx: CodegenContext, fctx: FunctionContext, value: ts.Expression): boolean {
  const valueType = compileExpression(ctx, fctx, value, EXTERNREF);
  if (valueType === undefined) return false;
  if (valueType === null) fctx.body.push({ op: "ref.null.extern" });
  else if (valueType.kind !== "externref") coerceType(ctx, fctx, valueType, EXTERNREF);
  return true;
}

/**
 * (#6644) The ONE entry point the class-static call ladder calls: `S.m(args)`
 * where `S` extends a LINKED provider class and declares no static `m`.
 *
 * `undefined` — having emitted nothing — for every other shape, which is every
 * call in a module that consumes no standalone provider.
 */
export function tryEmitLinkedStaticCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  receiver: ts.Identifier,
  nameKeyedClassName: string,
  methodName: string,
): ValType | undefined {
  if (ctx.staticMethodSet.has(`${nameKeyedClassName}_${methodName}`)) return undefined;
  // (#5383 S67) Identity, not name — see {@link resolveLinkedStaticClassName}.
  const className = resolveLinkedStaticClassName(ctx, receiver);
  if (className === undefined) return undefined;
  if (ctx.staticMethodSet.has(`${className}_${methodName}`)) return undefined;
  if (linkedStaticParentHeritage(ctx, className, methodName) === undefined) return undefined;
  const emitted = emitLinkedStaticMemberCall(ctx, fctx, className, { name: methodName }, expr.arguments, (value) =>
    pushExtern(ctx, fctx, value),
  );
  return emitted ? EXTERNREF : undefined;
}

/**
 * (#6644, #5383 S67) `S[k](...args)` — the COMPUTED call of an inherited
 * static whose argument list contains a RUNTIME SPREAD. This is the shape
 * test262's `TemporalHelpers.checkThisValueNotCalled` writes verbatim
 * (`MySubclass[method](...methodArgs)`), and it is #6644's residual 2.
 *
 * ## Why the computed READ arm is not enough
 *
 * The read arm hands back a plain externref callee, and the CALL of that value
 * is then lowered by `calls.ts::tryEmitInlineDynamicCall` (measured: that is
 * the arm that fires). Its argument marshalling is fixed-arity —
 * `expr.arguments.length` locals, one per AST node — so a spread contributes
 * exactly ONE value: the source array. Measured on the branch base with the
 * two-module fixture (`.tmp/s67/probes/p32.mts`), a provider static echoing its
 * arguments:
 *
 * | call | base |
 * | --- | --- |
 * | `NS.Base.two(...A2)` directly on the provider (control) | `two:p,q:2` |
 * | `Sub[m](...A2)` where `Sub extends construct` | `two:p,q,undefined:1` |
 *
 * `arguments.length` is 1 and the first formal is the ARRAY. (The one-element
 * case masks itself: `"one:" + ["p"]` and `"one:" + "p"` print the same, which
 * is why S66 saw it only as a `year is required` from the real provider.)
 *
 * ## The mechanism
 *
 * Route the whole call — not just the read — through the same
 * `__apply_closure(__extern_get(P, ToPropertyKey(k)), P, argv)` terminal the
 * NAMED form already uses, whose argv is a runtime vector and therefore has an
 * exact answer for a spread (`tryEmitSpreadHostArgs`).
 *
 * **Gated on the spread being PRESENT**, deliberately: without one the
 * existing dynamic-call lowering is already correct (`S[m](lit)` answers
 * `2000` against the real provider) and keeping it means this change adds no
 * instruction to any call site that works today. The remaining gates are the
 * computed READ arm's, for the same reasons: a side-effect-free key (the
 * fallback would evaluate it twice), an identifier receiver resolved by
 * DECLARATION identity, and a refusal for any class with an own static (the
 * `illegal cast` trap documented on {@link declaresAnyOwnStatic}).
 */
export function tryEmitLinkedStaticComputedCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  elemAccess: ts.ElementAccessExpression,
): ValType | undefined {
  if (ctx.classLinkedDynamicParentExpr.size === 0) return undefined;
  if (!hasSpreadArgument(expr.arguments)) return undefined;
  const key = elemAccess.argumentExpression;
  if (key === undefined) return undefined;
  if (!ts.isIdentifier(key) && !ts.isStringLiteralLike(key)) return undefined;
  if (!ts.isIdentifier(elemAccess.expression)) return undefined;
  const className = resolveLinkedStaticClassName(ctx, elemAccess.expression);
  if (className === undefined) return undefined;
  if (!ctx.classLinkedDynamicParentExpr.has(className)) return undefined;
  if (declaresAnyOwnStatic(ctx, className)) return undefined;
  const emitted = emitLinkedStaticMemberCall(ctx, fctx, className, { key }, expr.arguments, (value) =>
    pushExtern(ctx, fctx, value),
  );
  return emitted ? EXTERNREF : undefined;
}

/**
 * (#6644) Does `className` declare ANY own static surface?
 *
 * The COMPUTED read cannot ask "does the class own THIS key" — the key is only
 * known at run time — so a class with any own static is refused outright. That
 * is not a precision nicety: with an own static present, the wrapped lowering
 * takes a different (closure-carrier) shape and the fallback's uniform
 * externref handling trapped with an uncatchable `illegal cast` on
 * `SubOwn["tag"]()` (measured, the witness's own control). The NAMED arms have
 * the key in hand and shadow correctly, so nothing is lost for a class that
 * mixes its own statics with inherited ones except the computed spelling.
 */
function declaresAnyOwnStatic(ctx: CodegenContext, className: string): boolean {
  const prefix = `${className}_`;
  for (const key of ctx.staticMethodSet) if (key.startsWith(prefix)) return true;
  for (const key of ctx.staticAccessorSet) if (key.startsWith(prefix)) return true;
  for (const key of ctx.staticProps.keys()) if (key.startsWith(prefix)) return true;
  return false;
}

/**
 * (#6644) `S[k]` — the COMPUTED read of an inherited static, and with it every
 * computed CALL shape including the spread one test262 actually writes
 * (`MySubclass[method](...methodArgs)`).
 *
 * Measured with the named arms already landed: `typeof Sub["tag"]` was
 * `undefined` while `typeof Sub.tag` answered `"function"`, and
 * `S[method](...args)` died in the callee guard — so the defect is in the READ,
 * not in any call form. One arm therefore serves all of them.
 *
 * Shape, and why it is a strict SUPERSET of today's answer:
 *
 * ```
 * r = <the existing lowering>                    // own statics, sidecar, everything
 * if (r === null || r === undefined) r = __extern_get(<linked parent>, ToPropertyKey(k))
 * ```
 *
 * The own half is the compiler's existing element-access lowering, called
 * through `compileOwn`, so no answer this module could give is lost — only a
 * MISS is replaced. That is also why it cannot be written as
 * `__extern_get(<class object>, k)`: a class object's own static surface is
 * reachable through several carriers (the #5195 sidecar, `staticProps`
 * globals, a callable static field), and re-deriving it here would be weaker
 * than the ladder that already knows about all of them (the #5820 regression
 * `emitClassValueDynamicCall` documents is exactly that mistake).
 *
 * **Restricted to a side-effect-free KEY** (an identifier or a string literal),
 * because the fallback evaluates the key a second time and §13.3.3 evaluates it
 * once. That covers `MySubclass[method]` exactly; any other key expression
 * declines and keeps today's behaviour rather than duplicating an observable
 * evaluation.
 */
export function tryEmitLinkedStaticComputedRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  elemAccess: ts.ElementAccessExpression,
  compileOwn: () => ValType | null | undefined,
): ValType | undefined {
  const key = elemAccess.argumentExpression;
  if (key === undefined) return undefined;
  if (!ts.isIdentifier(key) && !ts.isStringLiteralLike(key)) return undefined;
  if (!ts.isIdentifier(elemAccess.expression)) return undefined;
  // (#5383 S67) Identity, not name — see {@link resolveLinkedStaticClassName}.
  const className = resolveLinkedStaticClassName(ctx, elemAccess.expression);
  if (className === undefined) return undefined;
  if (!ctx.classLinkedDynamicParentExpr.has(className)) return undefined;
  if (declaresAnyOwnStatic(ctx, className)) return undefined;
  const externGetIdx = ensureLateImport(ctx, "__extern_get", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  const isUndefinedIdx = ensureLateImport(ctx, "__extern_is_undefined", [EXTERNREF], [{ kind: "i32" }]);
  if (externGetIdx === undefined || isUndefinedIdx === undefined) return undefined;
  flushLateImportShifts(ctx, fctx);

  // (#1919) Transactional: the wrapped own lowering, the scratch local and the
  // fallback block are all rolled back together when any half declines. The
  // temporary `fctx.body` swap that builds the fallback block is fully internal
  // — `fctx.body` is the original array again before any outcome is returned,
  // so the snapshot's body handle is the one that gets restored.
  return withSpeculativeCompile<ValType | undefined>(ctx, fctx, () => {
    const ownType = compileOwn();
    if (ownType === undefined) return { commit: false, value: undefined };
    if (ownType === null) fctx.body.push({ op: "ref.null.extern" });
    else if (ownType.kind !== "externref") coerceType(ctx, fctx, ownType, EXTERNREF);

    const valueLocal = allocLocal(fctx, `__lsi_cval_${fctx.locals.length}`, EXTERNREF);
    fctx.body.push({ op: "local.set", index: valueLocal });
    const fallback: Instr[] = [];
    const saved = fctx.body;
    fctx.body = fallback;
    const parentPushed = pushLinkedDynamicParent(ctx, fctx, className, (expr) => pushExtern(ctx, fctx, expr));
    const keyPushed = parentPushed && pushExtern(ctx, fctx, key);
    if (keyPushed) {
      emitToPropertyKeyOnce(ctx, fctx);
      fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__extern_get") ?? externGetIdx } satisfies Instr);
      fctx.body.push({ op: "local.set", index: valueLocal });
    }
    fctx.body = saved;
    if (!keyPushed) return { commit: false, value: undefined };
    fctx.body.push({ op: "local.get", index: valueLocal });
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({ op: "local.get", index: valueLocal });
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__extern_is_undefined") ?? isUndefinedIdx });
    fctx.body.push({ op: "i32.or" });
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: fallback });
    fctx.body.push({ op: "local.get", index: valueLocal });
    return { commit: true, value: EXTERNREF };
  });
}
