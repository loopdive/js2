// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// standalone-dynamic-parent-class.ts — (#6640, #5383 S64) `class S extends
// <linked-provider class>` under `--target standalone` / `wasi`.
//
// ## The defect
//
// `class-bodies.ts::collectClassDeclaration`'s heritage loop wires a real
// parent only for an `Identifier`/`ClassExpression` heritage that resolves to a
// LOCAL class declaration. A PROPERTY-ACCESS heritage into a linked provider
// namespace — `class AvoidGettersDate extends Temporal.PlainDate {}`, the shape
// every test262 `Temporal/*/compare/use-internal-slots.js` and
// `subclassing-ignored.js` row uses — fell into an arm that only marked
// `ctx.classDynamicUnresolvedHeritageSet` (#6623). The subclass compiled as a
// fully independent ROOT struct: `super(...)` never reached the provider's
// constructor (no internal slots), no inherited method/getter dispatch
// (`one.toString()` → `"[object Object]"`, `one.year` → `undefined`), and
// `one instanceof Temporal.PlainDate` was `false`. The JS-host lane has had the
// analogous capability since #4534 (`hasDynamicHostParent` /
// `__call_dynamic_class_parent_<N>`); standalone had NOTHING.
//
// ## The mechanism — `this` IS the parent-constructed object
//
// Such a class becomes EXTERNREF-BACKED (`ctx.classExternrefBackedSet`), the
// same representation `class Sub extends Error` already uses on this lane, and
// its `super(...)` (explicit, or the synthesized derived constructor) lowers to
// the EXISTING dynamic `__native_construct_<N>` driver (#3981) applied to the
// heritage EXPRESSION evaluated at runtime. That driver already has an arm for
// a provider-owned class value — it asks the peer's
// `__js2wasm_link_callable_kind` for [[Construct]] and forwards to
// `__js2wasm_link_construct` (#5383 S2f R12), which runs the provider's own
// `<Name>_new` (#5383 S2g). So `this` is not a consumer-side imitation of a
// provider instance: it IS the provider-minted struct, with the provider's
// internal fields installed by the provider's own constructor.
//
// Everything downstream then works by construction rather than by
// re-implementation: an inherited read or method call on that receiver misses
// the consumer's own ladder and reaches the established link `memberGet` /
// `methodCall` terminals, exactly as a direct `new NS.Base()` instance already
// did; and a value handed BACK to the provider (`Temporal.PlainDate.compare(one,
// two)`) brand-checks as a real instance because it is one.
//
// ## Deliberate scope, and what is NOT claimed
//
//  - PROPERTY/ELEMENT-ACCESS heritage, plus — since #6644/S66 — an unresolvable
//    IDENTIFIER heritage that names a function PARAMETER (test262's
//    `checkSubclassConstructorUndefined` / `checkThisValueNotCalled` shape,
//    #6640's residual 2). The identifier arm is shared with EVERY
//    `extends <builtin>` spelling, so the widening runs only after the
//    host-constructible-builtin and extern-class arms have both declined and
//    `classBuiltinParentMap` is untouched. Its heritage VALUE is in scope at
//    exactly one point, so it is captured into a module global there — see
//    {@link isLinkedDynamicParentIdentifier} and
//    {@link emitLinkedDynamicParentCapture}.
//  - LINK CONSUMERS only (`peerNamespaces(ctx)` non-empty). A standalone module
//    with no linked provider emits byte-identical output, which is what keeps
//    the whole non-linked corpus — including the provider modules themselves —
//    out of this change's blast radius.
//  - The subclass's OWN declared instance fields/methods are not installed on
//    the parent-minted object (the same bound `class Sub extends Error` has
//    carried since #1366a). `instanceof <the subclass itself>` and
//    `Object.getPrototypeOf(instance) === Sub.prototype` consequently answer
//    `false` where the root-struct representation answered `true`; both are
//    recorded in #6640, and neither is reachable without a heritage clause that
//    had no compiled meaning at all before this change.
import ts from "typescript";
import type { Instr } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { MAX_DYNAMIC_CONSTRUCT_ARITY, reserveNativeConstructDriver } from "./native-construct.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { isStandaloneLinkConsumer } from "./standalone-link-boundary.js";
import { nextModuleGlobalIdx } from "./registry/imports.js";

/**
 * Is `baseExpr` a heritage expression this module can construct through the
 * link boundary?
 *
 * Property/element access only, and only in a standalone/WASI module that
 * actually consumes a wasm provider — see the scope note above.
 */
export function isLinkedDynamicParentHeritage(ctx: CodegenContext, baseExpr: ts.Expression): boolean {
  if (!ctx.standalone && !ctx.wasi) return false;
  if (!ts.isPropertyAccessExpression(baseExpr) && !ts.isElementAccessExpression(baseExpr)) return false;
  return isStandaloneLinkConsumer(ctx);
}

/**
 * (#6644) The IDENTIFIER twin: `class MySubclass extends construct {}` where
 * `construct` is a PARAMETER of an enclosing function holding a provider class
 * object — test262's `checkSubclassConstructorUndefined` /
 * `checkThisValueNotCalled` shape, and #6640's residual 2.
 *
 * The caller has already established that the identifier resolves to NO local
 * class, carries no struct, and took neither the host-constructible-builtin nor
 * the extern-class arm — so `classBuiltinParentMap` is untouched and every
 * `extends <builtin>` spelling keeps its existing representation byte for byte.
 * This adds the one case that arm never covered: an identifier whose value is
 * only knowable at run time.
 *
 * The predicate is PURELY SYNTACTIC on purpose — "is this name a formal of an
 * enclosing function?" — rather than a static-type question. Two reasons:
 * a linked namespace member is typed `any`, so the type carries no information
 * to discriminate on; and `class-bodies.ts` is on the raw-checker ratchet
 * (#1930/#3273), where one more raw query needs a grant this narrow question
 * does not justify. A parameter binding is also exactly the "value known only
 * at run time" property the dynamic construct driver needs, which is the
 * property that matters here.
 */
export function isLinkedDynamicParentIdentifier(
  ctx: CodegenContext,
  decl: ts.ClassDeclaration | ts.ClassExpression,
  baseExpr: ts.Identifier,
): boolean {
  if (!ctx.standalone && !ctx.wasi) return false;
  if (!isStandaloneLinkConsumer(ctx)) return false;
  // The heritage value must be CAPTURABLE, and the one place it is in scope is
  // this declaration's own statement. `statements.ts`'s nested-class arm is the
  // hook that runs there, and it only sees a ClassDeclaration in a BLOCK — so
  // anything else is refused rather than claimed-and-left-uncaptured, which
  // would turn today's (wrong but harmless) independent root struct into a
  // `null` instance. A half-taken path is a regression; declining is not.
  if (!ts.isClassDeclaration(decl) || decl.parent === undefined || !ts.isBlock(decl.parent)) return false;
  const name = baseExpr.text;
  for (let node: ts.Node | undefined = baseExpr.parent; node !== undefined; node = node.parent) {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node)
    ) {
      for (const parameter of node.parameters) {
        if (ts.isIdentifier(parameter.name) && parameter.name.text === name) return true;
      }
    }
  }
  return false;
}

/**
 * Emit `self = __native_construct_<argCount>(<heritage value>, null, …args)`
 * and store it into `selfLocal`.
 *
 * `pushArgs` is the caller's argument emission (each callee-pushed value must
 * be an externref): the explicit-`super(...)` site compiles the argument
 * expressions, the synthesized derived constructor forwards its `__arg{i}`
 * parameters. Returns false — emitting nothing — when the driver cannot be
 * reserved, so the caller keeps its previous (null-instance) lowering rather
 * than producing a half-built body.
 */
export function emitLinkedDynamicParentConstruct(
  ctx: CodegenContext,
  fctx: FunctionContext,
  className: string,
  argCount: number,
  pushArgs: () => void,
  compileHeritage: (expr: ts.Expression) => void,
): boolean {
  const heritage = ctx.classLinkedDynamicParentExpr.get(className);
  if (heritage === undefined || argCount > MAX_DYNAMIC_CONSTRUCT_ARITY) return false;
  const driverIdx = reserveNativeConstructDriver(ctx, argCount, stringConstantExternrefInstrs(ctx, "prototype"));
  if (driverIdx === undefined) return false;
  // (#6644) A captured IDENTIFIER heritage reads its global instead: the
  // parameter it names is not in scope inside this (synthesized) constructor.
  const pushed = pushLinkedDynamicParent(ctx, fctx, className, (expr) => {
    compileHeritage(expr);
    return true;
  });
  if (!pushed) return false;
  // Null NewTarget-prototype: the driver's boundary arm lets the PROVIDER pick
  // the prototype its own constructor would, which is the whole point — a
  // consumer-side prototype would detach the instance from the provider's
  // method table.
  fctx.body.push({ op: "ref.null.extern" } as Instr);
  pushArgs();
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get(`__native_construct_${argCount}`) ?? driverIdx });
  return true;
}

/**
 * (#6644) Record an IDENTIFIER heritage as a linked dynamic parent AND mint the
 * module global that will capture its value at ClassDefinitionEvaluation.
 *
 * Both halves belong together: the global is the ONLY way any later consumer
 * can reach a parameter's value, so a record without one is the half-taken path
 * {@link isLinkedDynamicParentIdentifier} exists to refuse.
 */
export function recordLinkedDynamicParentIdentifier(
  ctx: CodegenContext,
  className: string,
  baseExpr: ts.Identifier,
): void {
  ctx.classLinkedDynamicParentExpr.set(className, baseExpr);
  ctx.classExternrefBackedSet.add(className);
  const captureGlobalIdx = nextModuleGlobalIdx(ctx);
  ctx.mod.globals.push({
    name: `__linked_parent_${className}`,
    type: { kind: "externref" },
    mutable: true,
    init: [{ op: "ref.null.extern" }],
  });
  ctx.classLinkedDynamicParentGlobal.set(className, captureGlobalIdx);
}

/**
 * (#6644) `global.set` the captured linked-parent value at the class
 * declaration's own statement — the only point where an IDENTIFIER heritage
 * (a function parameter) is in scope. No-op for every other class.
 *
 * Returns false having emitted nothing when the class has no capture global or
 * the heritage value could not be compiled.
 */
export function emitLinkedDynamicParentCapture(
  ctx: CodegenContext,
  fctx: FunctionContext,
  className: string,
  compileHeritage: (expr: ts.Expression) => boolean,
): boolean {
  const globalIdx = ctx.classLinkedDynamicParentGlobal.get(className);
  const heritage = ctx.classLinkedDynamicParentExpr.get(className);
  if (globalIdx === undefined || heritage === undefined) return false;
  const mark = fctx.body.length;
  if (!compileHeritage(heritage)) {
    fctx.body.length = mark;
    return false;
  }
  fctx.body.push({ op: "global.set", index: globalIdx });
  return true;
}

/**
 * (#6644) Push the linked parent CLASS OBJECT of `className`, or return false
 * having emitted nothing.
 *
 * Two shapes, one answer: a captured IDENTIFIER heritage reads its global; a
 * property/element-access heritage re-compiles its expression (a pure read of
 * a module-level binding — see the note on
 * {@link emitLinkedDynamicParentConstruct}).
 */
export function pushLinkedDynamicParent(
  ctx: CodegenContext,
  fctx: FunctionContext,
  className: string,
  compileHeritage: (expr: ts.Expression) => boolean,
): boolean {
  const globalIdx = ctx.classLinkedDynamicParentGlobal.get(className);
  if (globalIdx !== undefined) {
    fctx.body.push({ op: "global.get", index: globalIdx });
    return true;
  }
  const heritage = ctx.classLinkedDynamicParentExpr.get(className);
  if (heritage === undefined) return false;
  return compileHeritage(heritage);
}

/**
 * (#6644) {@link emitLinkedDynamicParentCapture} over the names one class
 * declaration may be registered under — its per-site synthetic identity (#4618)
 * and its source name. At most one of them owns a capture global; the rest are
 * no-ops.
 */
export function emitLinkedDynamicParentCaptureForNames(
  ctx: CodegenContext,
  fctx: FunctionContext,
  names: ReadonlyArray<string | undefined>,
  compileHeritage: (expr: ts.Expression) => boolean,
): void {
  for (const className of names) {
    if (className === undefined) continue;
    if (emitLinkedDynamicParentCapture(ctx, fctx, className, compileHeritage)) return;
  }
}
