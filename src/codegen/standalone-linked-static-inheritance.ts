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
import { allocLocal } from "./context/locals.js";
import { coerceType, compileExpression } from "./shared.js";
import { pushLinkedDynamicParent } from "./standalone-dynamic-parent-class.js"; // (#6644) captured identifier heritage

const EXTERNREF: ValType = { kind: "externref" };

/**
 * Own properties of a class object that a derived class gets for itself, and
 * that must therefore never be forwarded to the linked parent.
 */
const NOT_INHERITED = new Set(["prototype", "name", "length", "constructor"]);

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
  const mark = fctx.body.length;
  if (!pushLinkedDynamicParent(ctx, fctx, className, compileHeritage)) {
    fctx.body.length = mark;
    return false;
  }
  fctx.body.push(...stringConstantExternrefInstrs(ctx, propName));
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__extern_get") ?? externGetIdx } satisfies Instr);
  return true;
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
  propName: string,
  args: readonly ts.Expression[],
  pushExtern: (expr: ts.Expression) => boolean,
): boolean {
  const externGetIdx = ensureLateImport(ctx, "__extern_get", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  if (externGetIdx === undefined) return false;
  const { newIdx, pushIdx } = ensureObjVecBuilders(ctx);
  const applyIdx = reserveApplyClosure(ctx);
  flushLateImportShifts(ctx, fctx);
  const mark = fctx.body.length;

  // §13.3.6.1: the MemberExpression is evaluated and GetValue'd BEFORE the
  // arguments, so the parent read comes first and is held in a local.
  const parentLocal = allocLocal(fctx, `__lsi_parent_${fctx.locals.length}`, EXTERNREF);
  const calleeLocal = allocLocal(fctx, `__lsi_callee_${fctx.locals.length}`, EXTERNREF);
  if (!pushLinkedDynamicParent(ctx, fctx, className, pushExtern)) {
    fctx.body.length = mark;
    return false;
  }
  fctx.body.push({ op: "local.tee", index: parentLocal });
  fctx.body.push(...stringConstantExternrefInstrs(ctx, propName));
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__extern_get") ?? externGetIdx } satisfies Instr);
  fctx.body.push({ op: "local.set", index: calleeLocal });

  const argsLocal = allocLocal(fctx, `__lsi_args_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push({ op: "call", funcIdx: newIdx });
  fctx.body.push({ op: "local.set", index: argsLocal });
  for (const arg of args) {
    fctx.body.push({ op: "local.get", index: argsLocal });
    if (!pushExtern(arg)) {
      fctx.body.length = mark;
      return false;
    }
    fctx.body.push({ op: "call", funcIdx: pushIdx } satisfies Instr);
  }
  fctx.body.push({ op: "local.get", index: calleeLocal });
  fctx.body.push({ op: "local.get", index: parentLocal });
  fctx.body.push({ op: "local.get", index: argsLocal });
  fctx.body.push({ op: "call", funcIdx: applyIdx });
  return true;
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
  className: string,
  methodName: string,
): ValType | undefined {
  if (ctx.staticMethodSet.has(`${className}_${methodName}`)) return undefined;
  if (expr.arguments.some((argument) => ts.isSpreadElement(argument))) return undefined;
  if (linkedStaticParentHeritage(ctx, className, methodName) === undefined) return undefined;
  const emitted = emitLinkedStaticMemberCall(ctx, fctx, className, methodName, expr.arguments, (value) =>
    pushExtern(ctx, fctx, value),
  );
  return emitted ? EXTERNREF : undefined;
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
  const className = ctx.classExprNameMap.get(elemAccess.expression.text) ?? elemAccess.expression.text;
  if (!ctx.classLinkedDynamicParentExpr.has(className)) return undefined;
  const externGetIdx = ensureLateImport(ctx, "__extern_get", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  const isUndefinedIdx = ensureLateImport(ctx, "__extern_is_undefined", [EXTERNREF], [{ kind: "i32" }]);
  if (externGetIdx === undefined || isUndefinedIdx === undefined) return undefined;
  flushLateImportShifts(ctx, fctx);

  const mark = fctx.body.length;
  const ownType = compileOwn();
  if (ownType === undefined) {
    fctx.body.length = mark;
    return undefined;
  }
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
  if (!keyPushed) {
    fctx.body.length = mark;
    return undefined;
  }
  fctx.body.push({ op: "local.get", index: valueLocal });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({ op: "local.get", index: valueLocal });
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__extern_is_undefined") ?? isUndefinedIdx });
  fctx.body.push({ op: "i32.or" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: fallback });
  fctx.body.push({ op: "local.get", index: valueLocal });
  return EXTERNREF;
}
