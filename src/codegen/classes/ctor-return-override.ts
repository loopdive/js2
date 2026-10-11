// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6772 S2) §10.2.1.3 [[Construct]] step 13 — the return-override channel for
 * struct-represented user classes (standalone).
 *
 * A class constructor compiles to `<C>_init(...params, self) -> (ref $C)`, so
 * its result can only ever be the class's own struct: `return o` / `return {}`
 * with a FOREIGN object was discarded (the `ref.test` arm in
 * `statements/control-flow.ts` falls back to `this`). Rather than re-type every
 * constructor, the override travels in a side channel:
 *
 *   - `$__ctor_override` (externref module global) is a RETURN REGISTER: every
 *     exit of a MARKED class's `_init` writes it (the override object, or null
 *     for "no override"), and it is read only immediately after a call to a
 *     marked `_init`/`_new` — at the `new` site, or at a `super(...)` into a
 *     marked parent. Because every exit writes it, a stale value from an
 *     unrelated construction can never be observed.
 *   - a derived frame whose parent is marked keeps the parent's override in a
 *     frame local (`__super_override`), read right after the `super(...)`
 *     BindThisValue (so a second, throwing `super()` cannot replace it), and
 *     writes it back on every exit that does not return its own Object.
 *   - the `new` site of a marked class yields externref: the register when
 *     non-null, else the struct.
 *
 * A class is MARKED when its own constructor has a `return <expr>` whose
 * operand is not `this` and not statically primitive, or when its parent is
 * marked (the override flows through `super()`). Marked classes resolve to
 * `externref` bindings (`externrefBackedClassValType`), so a slot can hold the
 * override object. Parents are marked before their children are collected;
 * a child collected first is not retro-marked (its bindings may already be
 * typed) — recorded residual.
 */
import { forEachChild, ts } from "../../ts-api.js";
import type { Instr, ValType } from "../../ir/types.js";
import { findConstructorImplementation } from "../ast-modifiers.js";
import { allocLocal, allocTempLocal, getLocalType, releaseTempLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
// (#6797) core helpers through the late-bound delegates, so this leaf stays out of the codegen SCC.
import {
  buildThrowJsErrorInstrs,
  classIdentityFromExpression,
  compileObjectLiteralAsExternref,
} from "../helpers/core-delegates.js";
import {
  compileExpression,
  coerceType,
  ensureLateImport,
  flushLateImportShifts,
  resolveEnclosingClassName,
  skipTransparentExpressions,
} from "../shared.js";

const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };
const OVERRIDE_GLOBAL = "__ctor_override";
const DERIVED_RETURN_MESSAGE = "Derived constructors may only return an object or undefined";

const markedClasses = new WeakMap<CodegenContext, Set<string>>();
/** (#6774 S22) Top-level FUNCTION parents whose body may return an Object. */
const fnctorOverrideParents = new WeakMap<CodegenContext, Set<string>>();
const frameOverrideLocals = new WeakMap<FunctionContext, number>();

/** Is `className` a return-override class (standalone only)? */
export function isCtorReturnOverrideClass(ctx: CodegenContext, className: string | undefined): boolean {
  return className !== undefined && (markedClasses.get(ctx)?.has(className) ?? false);
}

/**
 * `recv.p` / `recv[k]` (not `this`, `super` or a private name) whose receiver
 * the checker types as a return-override class: the value may be the foreign
 * override object, so a type-based fold of the member (e.g. `typeof`) is
 * unsound.
 */
export function isReturnOverrideMemberRead(ctx: CodegenContext, expr: ts.Expression): boolean {
  if (!ctx.standalone || markedClasses.get(ctx) === undefined) return false;
  const e = skipTransparentExpressions(expr);
  if (!ts.isPropertyAccessExpression(e) && !ts.isElementAccessExpression(e)) return false;
  if (ts.isPropertyAccessExpression(e) && ts.isPrivateIdentifier(e.name)) return false;
  const className = markedInstanceValueClass(ctx, e.expression);
  if (className === undefined) return false;
  // Only a DATA member: a class accessor / method keeps the struct lowering
  // (a foreign override object then misses them: recorded residual).
  if (ts.isPropertyAccessExpression(e)) return !isClassCallableMember(ctx, className, e.name.text);
  return true;
}

/**
 * The marked class an INSTANCE-valued expression is typed as — never `this` /
 * `super`, the class object itself (`C`, whose declared name is also `C`) or a
 * `.prototype` read, whose values no constructor return can replace.
 */
function markedInstanceValueClass(ctx: CodegenContext, expr: ts.Expression): string | undefined {
  const e = skipTransparentExpressions(expr);
  if (e.kind === ts.SyntaxKind.ThisKeyword || e.kind === ts.SyntaxKind.SuperKeyword) return undefined;
  if (ts.isPropertyAccessExpression(e) && e.name.text === "prototype") return undefined;
  if (classIdentityFromExpression(ctx, e) !== undefined) return undefined;
  const name = ctx.oracle.declaredNameOf(e);
  if (name === undefined) return undefined;
  const className = isCtorReturnOverrideClass(ctx, name) ? name : ctx.classExprNameMap.get(name);
  return isCtorReturnOverrideClass(ctx, className) ? className : undefined;
}

/**
 * `Object.getPrototypeOf(<binding of a return-override class>)`: the class
 * folds would answer `C.prototype` for the foreign override object too —
 * read the value's real [[Prototype]] instead. Returns undefined (nothing
 * emitted) for every other argument.
 */
export function tryEmitOverrideBindingGetPrototypeOf(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arg: ts.Expression,
): ValType | undefined {
  if (!ctx.standalone || markedClasses.get(ctx) === undefined) return undefined;
  if (markedInstanceValueClass(ctx, arg) === undefined) return undefined;
  const gptIdx = ensureLateImport(ctx, "__getPrototypeOf", [EXTERNREF], [EXTERNREF]);
  flushLateImportShifts(ctx, fctx);
  if (gptIdx === undefined) return undefined;
  const argType = compileExpression(ctx, fctx, arg);
  if (!argType) fctx.body.push({ op: "ref.null.extern" });
  else if (argType.kind !== "externref") coerceType(ctx, fctx, argType, EXTERNREF);
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__getPrototypeOf") ?? gptIdx });
  return EXTERNREF;
}

/** Is `prop` a method or accessor of `className` or one of its user ancestors? */
function isClassCallableMember(ctx: CodegenContext, className: string, prop: string): boolean {
  const seen = new Set<string>();
  for (let c: string | undefined = className; c !== undefined && !seen.has(c); c = ctx.classParentMap.get(c)) {
    seen.add(c);
    const key = `${c}_${prop}`;
    if (ctx.classMethodSet.has(key) || ctx.classAccessorSet.has(key)) return true;
  }
  return false;
}

/**
 * `resolveStructNameForExpr`'s hook: a DATA member of a return-override
 * class binding (not `this`) resolves dynamically — the slot may hold the
 * foreign override object.
 */
export function returnOverrideReceiverIsDynamic(
  ctx: CodegenContext,
  fctx: FunctionContext,
  typeName: string,
  receiver: ts.Expression,
  member: ts.MemberName | undefined,
): boolean {
  if (!ctx.standalone || member === undefined || !ts.isIdentifier(member)) return false;
  if (!isCtorReturnOverrideClass(ctx, typeName)) return false;
  const recv = skipTransparentExpressions(receiver);
  if (recv.kind === ts.SyntaxKind.SuperKeyword) return false;
  // `this` is the struct everywhere except a derived constructor frame whose
  // parent may override, where it is `tryEmitDerivedEffectiveThis`'s value.
  if (recv.kind === ts.SyntaxKind.ThisKeyword && !frameThisMayBeOverride(ctx, fctx)) return false;
  return !isClassCallableMember(ctx, typeName, member.text);
}

/** A primitive the operand provably is, so no override can come of it. */
function isProvablyNonObjectReturn(ctx: CodegenContext, expr: ts.Expression): boolean {
  const e = skipTransparentExpressions(expr);
  switch (e.kind) {
    case ts.SyntaxKind.ThisKeyword:
    case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.BigIntLiteral:
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
    case ts.SyntaxKind.TemplateExpression:
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.NullKeyword:
    case ts.SyntaxKind.VoidExpression:
      return true;
  }
  if (ts.isIdentifier(e) && e.text === "undefined") return true;
  const tag = ctx.oracle.staticJsTypeOf(e);
  return tag !== "object" && tag !== "function" && tag !== "mixed";
}

/** Does the class's OWN constructor body (not nested functions) return a possible Object? */
function ctorMayReturnObject(ctx: CodegenContext, decl: ts.ClassDeclaration | ts.ClassExpression): boolean {
  const ctor = findConstructorImplementation(decl);
  return ctor?.body !== undefined && bodyMayReturnObject(ctx, ctor.body);
}

/**
 * (#6774 S22) `class C extends F` where `F` is a top-level FUNCTION whose own
 * body may `return` an Object: §10.2.1.3 step 13 makes that object `super()`'s
 * value and the derived `this`, so `F` joins the override channel as a parent.
 */
function fnctorParentMayReturnObject(ctx: CodegenContext, parent: string, decl: ts.Node): boolean {
  if (ctx.classSet.has(parent) || !ctx.topLevelFunctionNames.has(parent)) return false;
  const fn = decl
    .getSourceFile()
    .statements.find((st): st is ts.FunctionDeclaration => ts.isFunctionDeclaration(st) && st.name?.text === parent);
  return fn?.body !== undefined && bodyMayReturnObject(ctx, fn.body);
}

/** A parent (class or function) whose construction can publish an override. */
function parentMayOverride(ctx: CodegenContext, parent: string | undefined): boolean {
  if (parent === undefined) return false;
  return isCtorReturnOverrideClass(ctx, parent) || (fnctorOverrideParents.get(ctx)?.has(parent) ?? false);
}

function bodyMayReturnObject(ctx: CodegenContext, body: ts.Block): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression && !isProvablyNonObjectReturn(ctx, node.expression)) {
      found = true;
      return;
    }
    forEachChild(node, visit);
  };
  forEachChild(body, visit);
  return found;
}

/**
 * Collection-phase pre-scan (call once the class's parent link and
 * externref-backing are final, before any binding of it is typed).
 */
export function markCtorReturnOverrideClass(
  ctx: CodegenContext,
  className: string,
  decl: ts.ClassDeclaration | ts.ClassExpression,
): void {
  if (!ctx.standalone || ctx.classExternrefBackedSet.has(className)) return;
  let set = markedClasses.get(ctx);
  const parent = ctx.classParentMap.get(className);
  const fnctorParent = parent !== undefined && fnctorParentMayReturnObject(ctx, parent, decl);
  if (fnctorParent) {
    let parents = fnctorOverrideParents.get(ctx);
    if (!parents) fnctorOverrideParents.set(ctx, (parents = new Set()));
    parents.add(parent);
  }
  if ((parent !== undefined && set?.has(parent)) || fnctorParent || ctorMayReturnObject(ctx, decl)) {
    if (!set) markedClasses.set(ctx, (set = new Set()));
    set.add(className);
  }
}

function overrideGlobalIdx(ctx: CodegenContext): number {
  let rel = ctx.mod.globals.findIndex((g) => g.name === OVERRIDE_GLOBAL);
  if (rel < 0) {
    rel = ctx.mod.globals.length;
    ctx.mod.globals.push({ name: OVERRIDE_GLOBAL, type: EXTERNREF, mutable: true, init: [{ op: "ref.null.extern" }] });
  }
  return ctx.numImportGlobals + rel;
}

/** The frame's saved parent override (null when the parent did not override). */
function frameOverrideLocal(fctx: FunctionContext): number {
  let idx = frameOverrideLocals.get(fctx);
  if (idx === undefined) {
    idx = allocLocal(fctx, `__super_override_${fctx.locals.length}`, EXTERNREF);
    frameOverrideLocals.set(fctx, idx);
  }
  return idx;
}

/** The class whose constructor `fctx` compiles, when it is a marked class. */
function markedFrameClass(ctx: CodegenContext, fctx: FunctionContext): string | undefined {
  if (!fctx.isConstructor || fctx.isFnctorConstructor) return undefined;
  for (const suffix of ["_init", "_new"]) {
    if (!fctx.name.endsWith(suffix)) continue;
    const name = fctx.name.slice(0, -suffix.length);
    if (isCtorReturnOverrideClass(ctx, name)) return name;
  }
  const name = resolveEnclosingClassName(fctx);
  return isCtorReturnOverrideClass(ctx, name) ? name : undefined;
}

/** Push the frame's "no own override" answer: the parent's override (derived) or null. */
function pushFrameDefault(ctx: CodegenContext, fctx: FunctionContext, className: string): void {
  if (parentMayOverride(ctx, ctx.classParentMap.get(className))) {
    fctx.body.push({ op: "local.get", index: frameOverrideLocal(fctx) });
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }
}

/**
 * After a `super(...)` / implicit-ctor call into the parent `_init` returned
 * (and, for an explicit `super()`, after BindThisValue succeeded): keep the
 * parent's override for this frame's exits. No-op unless the parent is marked.
 */
export function emitSaveParentOverride(ctx: CodegenContext, fctx: FunctionContext, className: string): void {
  if (!parentMayOverride(ctx, ctx.classParentMap.get(className))) return;
  fctx.body.push({ op: "global.get", index: overrideGlobalIdx(ctx) });
  fctx.body.push({ op: "local.set", index: frameOverrideLocal(fctx) });
}

/**
 * `this` in a derived constructor whose parent may override (§9.1.1.3.1
 * BindThisValue binds the object `super(...)` returned): the parent's
 * override when one was bound, else the struct — as externref. Undefined
 * (nothing emitted) for every other frame. Closures capture the struct `this`
 * (recorded residual).
 */
function frameThisMayBeOverride(ctx: CodegenContext, fctx: FunctionContext): boolean {
  if (!ctx.standalone || !fctx.isDerivedConstructor || fctx.localMap.get("this") === undefined) return false;
  const className = markedFrameClass(ctx, fctx);
  return parentMayOverride(ctx, className === undefined ? undefined : ctx.classParentMap.get(className));
}

export function tryEmitDerivedEffectiveThis(ctx: CodegenContext, fctx: FunctionContext): ValType | undefined {
  if (!frameThisMayBeOverride(ctx, fctx)) return undefined;
  const selfIdx = fctx.localMap.get("this")!;
  const overrideLocal = frameOverrideLocal(fctx);
  fctx.body.push(
    { op: "local.get", index: overrideLocal },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: EXTERNREF },
      then: [{ op: "local.get", index: selfIdx }, { op: "extern.convert_any" }],
      else: [{ op: "local.get", index: overrideLocal }],
    },
  );
  return EXTERNREF;
}

/** Fall-off-the-end exit of a marked class's constructor body: publish the default. */
export function emitCtorFallthroughOverride(ctx: CodegenContext, fctx: FunctionContext, className: string): void {
  if (!isCtorReturnOverrideClass(ctx, className)) return;
  pushFrameDefault(ctx, fctx, className);
  fctx.body.push({ op: "global.set", index: overrideGlobalIdx(ctx) });
}

/** Bare `return;` in a marked class's constructor: publish the default. */
export function emitCtorBareReturnOverride(ctx: CodegenContext, fctx: FunctionContext): boolean {
  const className = markedFrameClass(ctx, fctx);
  if (className === undefined) return false;
  emitCtorFallthroughOverride(ctx, fctx, className);
  return true;
}

/**
 * `return <expr>` in a marked class's constructor. Evaluates the operand,
 * publishes §10.2.1.3's answer in the register, and leaves `self` on the stack
 * (the struct remains the function's result). Returns false — emitting
 * nothing — when this frame is not a marked constructor or the Type(V)
 * predicates are unavailable.
 */
export function tryEmitCtorOverrideReturn(
  ctx: CodegenContext,
  fctx: FunctionContext,
  operand: ts.Expression,
  selfIdx: number,
): boolean {
  const className = markedFrameClass(ctx, fctx);
  if (className === undefined) return false;
  const predicates = (): [number, number, number] | undefined => {
    const u = ensureLateImport(ctx, "__typeof_undefined", [EXTERNREF], [I32]);
    const o = ensureLateImport(ctx, "__typeof_object", [EXTERNREF], [I32]);
    const f = ensureLateImport(ctx, "__typeof_function", [EXTERNREF], [I32]);
    flushLateImportShifts(ctx, fctx);
    return u === undefined || o === undefined || f === undefined ? undefined : [u, o, f];
  };
  if (!predicates()) return false;
  const regIdx = overrideGlobalIdx(ctx);
  const derived = ctx.classParentMap.has(className);
  const e = skipTransparentExpressions(operand);
  if (e.kind === ts.SyntaxKind.ThisKeyword) {
    // `return this` is the frame's own `this` — the parent's override when one
    // was bound (§9.1.1.3.1), else the struct.
    pushFrameDefault(ctx, fctx, className);
    fctx.body.push({ op: "global.set", index: regIdx });
    fctx.body.push({ op: "local.get", index: selfIdx });
    return true;
  }
  // A data-only object literal is contextually typed as the CLASS itself (the
  // constructor's return position), so the closed-struct lowering would mint
  // an instance of the class's own struct — build the open `$Object` instead.
  const dataLiteral =
    ts.isObjectLiteralExpression(e) &&
    e.properties.every((p) => ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p));
  const valueType =
    (dataLiteral ? compileObjectLiteralAsExternref(ctx, fctx, e) : undefined) ?? compileExpression(ctx, fctx, operand);
  if (valueType === null || valueType === undefined) {
    fctx.body.push({ op: "ref.null.extern" });
  } else if (valueType.kind !== "externref") {
    coerceType(ctx, fctx, valueType, EXTERNREF);
  }
  const value = allocTempLocal(fctx, EXTERNREF);
  fctx.body.push({ op: "local.set", index: value });
  // Fresh instruction arrays per arm — no Instr object is shared between arms.
  const defaultArm = (): Instr[] => {
    const saved = fctx.body;
    const arm: Instr[] = [];
    fctx.body = arm;
    pushFrameDefault(ctx, fctx, className);
    fctx.body = saved;
    return arm;
  };
  const throwArm = (): Instr[] => buildThrowJsErrorInstrs(ctx, "TypeError", DERIVED_RETURN_MESSAGE, { flush: fctx });
  // Base: Object → override, anything else → discarded. Derived: Object →
  // override, undefined → `this`, null / other primitive → TypeError.
  const nullArm = derived ? throwArm() : defaultArm();
  const undefinedArms = derived ? { then: defaultArm(), else: throwArm() } : undefined;
  const baseNonObjectArm = derived ? undefined : defaultArm();
  // Re-read the predicate indices AFTER the throw arms registered their
  // constructor (a late registration may shift function indices).
  const [typeofUndefinedIdx, typeofObjectIdx, typeofFunctionIdx] = predicates()!;
  const nonObjectArm: Instr[] = undefinedArms
    ? [
        { op: "local.get", index: value },
        { op: "call", funcIdx: typeofUndefinedIdx },
        { op: "if", blockType: { kind: "val", type: EXTERNREF }, ...undefinedArms },
      ]
    : baseNonObjectArm!;
  fctx.body.push(
    { op: "local.get", index: value },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: EXTERNREF },
      then: nullArm,
      else: [
        { op: "local.get", index: value },
        { op: "call", funcIdx: typeofObjectIdx },
        { op: "local.get", index: value },
        { op: "call", funcIdx: typeofFunctionIdx },
        { op: "i32.or" },
        {
          op: "if",
          blockType: { kind: "val", type: EXTERNREF },
          then: [{ op: "local.get", index: value }],
          else: nonObjectArm,
        },
      ],
    },
    { op: "global.set", index: regIdx },
    { op: "local.get", index: selfIdx },
  );
  releaseTempLocal(fctx, value);
  return true;
}

/**
 * (#6774 S22) The fnctor arm of `super(...)` left the parent FUNCTION's return
 * value (`resultType`) on the stack: publish §10.2.1.3 step 13's answer in the
 * register — the value when it is an Object, else null (`this` stays) — for
 * `emitSaveParentOverride` to keep. Returns false (nothing emitted, the caller
 * drops the value) unless `parent` is a function override parent.
 */
export function tryEmitFnctorSuperOverride(
  ctx: CodegenContext,
  fctx: FunctionContext,
  parent: string,
  resultType: ValType,
): boolean {
  if (!(fnctorOverrideParents.get(ctx)?.has(parent) ?? false)) return false;
  if (resultType.kind !== "externref") coerceType(ctx, fctx, resultType, EXTERNREF);
  const o = ensureLateImport(ctx, "__typeof_object", [EXTERNREF], [I32]);
  const f = ensureLateImport(ctx, "__typeof_function", [EXTERNREF], [I32]);
  flushLateImportShifts(ctx, fctx);
  if (o === undefined || f === undefined) {
    fctx.body.push({ op: "drop" });
    return true;
  }
  const value = allocTempLocal(fctx, EXTERNREF);
  fctx.body.push(
    { op: "local.tee", index: value },
    { op: "call", funcIdx: o },
    { op: "local.get", index: value },
    { op: "call", funcIdx: f },
    { op: "i32.or" },
    {
      op: "if",
      blockType: { kind: "val", type: EXTERNREF },
      then: [{ op: "local.get", index: value }],
      else: [{ op: "ref.null.extern" }],
    },
    { op: "global.set", index: overrideGlobalIdx(ctx) },
  );
  releaseTempLocal(fctx, value);
  return true;
}

/**
 * (#6774 S22) The VALUE of a nested `super(...)` expression: the bound `this`
 * (§13.3.7.1 step 8 returns it) — the parent's override when one was bound,
 * else the instance struct — as externref. Always emits.
 */
export function emitSuperCallValue(ctx: CodegenContext, fctx: FunctionContext, selfIdx: number): ValType {
  if (tryEmitDerivedEffectiveThis(ctx, fctx) !== undefined) return EXTERNREF;
  fctx.body.push({ op: "local.get", index: selfIdx });
  const selfType = getLocalType(fctx, selfIdx);
  if (selfType?.kind === "ref" || selfType?.kind === "ref_null") fctx.body.push({ op: "extern.convert_any" });
  else if (selfType !== undefined && selfType.kind !== "externref") coerceType(ctx, fctx, selfType, EXTERNREF);
  return EXTERNREF;
}

/**
 * The `new` site of a marked class, right after `call <C>_new` left the struct
 * on the stack: yield the register when set (clearing it), else the struct.
 * Returns the resulting ValType, or undefined (nothing emitted) for an
 * unmarked class.
 */
export function emitNewSiteOverrideSelect(
  ctx: CodegenContext,
  fctx: FunctionContext,
  className: string,
): ValType | undefined {
  if (!isCtorReturnOverrideClass(ctx, className)) return undefined;
  const regIdx = overrideGlobalIdx(ctx);
  const tmp = allocTempLocal(fctx, EXTERNREF);
  fctx.body.push(
    { op: "extern.convert_any" },
    { op: "local.set", index: tmp },
    { op: "global.get", index: regIdx },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: EXTERNREF },
      then: [{ op: "local.get", index: tmp }],
      else: [{ op: "global.get", index: regIdx }, { op: "ref.null.extern" }, { op: "global.set", index: regIdx }],
    },
  );
  releaseTempLocal(fctx, tmp);
  return EXTERNREF;
}
