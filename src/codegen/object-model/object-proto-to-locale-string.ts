// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6770 S5) `Object.prototype.toLocaleString` on a PRIMITIVE `this` —
 * §20.1.3.5 is `Invoke(O, "toString")`, i.e. `GetV(O, "toString")` (a lookup
 * through the wrapper PROTOTYPE with the PRIMITIVE as receiver) and then a call
 * with that same primitive `this`.
 *
 * ```js
 * "use strict";
 * Boolean.prototype.toString = function () { return typeof this; };
 * true.toLocaleString();   // main: "true" (the intrinsic)   spec: "boolean"
 * ```
 *
 * The override lands (the #4176 brand companion holds it —
 * `gOPD(Boolean.prototype, "toString").value` answers the user function), but
 * every `<primitive>.toLocaleString()` lowering renders the intrinsic ToString
 * directly. When — and only when — the source writes
 * `<Wrapper>.prototype.toString`, this arm performs the spec Invoke instead:
 * `__reflect_get_receiver(<Wrapper>.prototype, "toString", recv)` (so an
 * ACCESSOR override's getter sees the primitive `this` too — the
 * `primitive_this_value_getter` row), then `__apply_closure(fn, recv, [])`.
 * A module that never overrides the member compiles byte-identically.
 */
import { symbolShadowsBuiltinGlobal } from "../../checker/builtin-shadow.js";
import type { ValType } from "../../ir/types.js";
import { ts } from "../../ts-api.js";
import { allocLocal } from "../context/locals.js";
import { isStrictFunction } from "../helpers/is-strict-function.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { coerceType, compileExpression, flushLateImportShifts } from "../shared.js";
import { bound } from "./ports.js"; // (#6770/#6797) core helpers, injected — keeps this leaf out of the import SCC

const sourceOverridesBuiltinPrototypeMember = bound("sourceOverridesBuiltinPrototypeMember");
const tryEnsureNativeProtoBrand = bound("tryEnsureNativeProtoBrand");
const emitFnctorSubclassDynamicMethodCall = bound("emitFnctorSubclassDynamicMethodCall");
const emitLazyNativeProtoGet = bound("emitLazyNativeProtoGet");
const stringConstantExternrefInstrs = bound("stringConstantExternrefInstrs");
const ensureObjectRuntime = bound("ensureObjectRuntime");
const ensureObjVecBuilders = bound("ensureObjVecBuilders");
const reserveApplyClosure = bound("reserveApplyClosure");
const addStringConstantGlobal = bound("addStringConstantGlobal");

const EXTERNREF: ValType = { kind: "externref" };

function wrapperOf(ctx: CodegenContext, recv: ts.Expression): string | undefined {
  switch (ctx.oracle.staticJsTypeOf(recv)) {
    case "boolean":
      return "Boolean";
    case "number":
      return "Number";
    case "string":
      return "String";
    default:
      return undefined;
  }
}

/**
 * The receiver `O` of an `Invoke(O, "toString")` spelling: `O.toString()` and
 * `O.toLocaleString()` (§20.1.3.5, unless the source replaces
 * `Object.prototype.toLocaleString`), and `Object.prototype.toLocaleString.call(O)`.
 */
function invokeToStringReceiver(
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
): ts.Expression | undefined {
  const member = propAccess.name.text;
  if (expr.arguments.length === 0 && (member === "toString" || member === "toLocaleString")) {
    return member === "toLocaleString" && sourceOverridesBuiltinPrototypeMember(expr, "Object", member)
      ? undefined
      : propAccess.expression;
  }
  const fn = propAccess.expression;
  if (
    member !== "call" ||
    expr.arguments.length !== 1 ||
    !ts.isPropertyAccessExpression(fn) ||
    fn.name.text !== "toLocaleString" ||
    !ts.isPropertyAccessExpression(fn.expression) ||
    fn.expression.name.text !== "prototype" ||
    !ts.isIdentifier(fn.expression.expression) ||
    fn.expression.expression.text !== "Object" ||
    sourceOverridesBuiltinPrototypeMember(expr, "Object", "toLocaleString")
  ) {
    return undefined;
  }
  return expr.arguments[0];
}

/** `Invoke(<primitive>, "toString")`, when the source overrides the wrapper's `toString`. */
export function tryEmitPrimitiveToLocaleStringInvoke(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
): ValType | undefined {
  if (!ctx.standalone) return undefined;
  const recvExpr = invokeToStringReceiver(expr, propAccess);
  if (recvExpr === undefined) return undefined;
  const wrapper = wrapperOf(ctx, recvExpr);
  if (wrapper === undefined) return tryEmitDynamicReceiverInvoke(ctx, fctx, expr, propAccess, recvExpr);
  if (!sourceOverridesBuiltinPrototypeMember(expr, wrapper, "toString")) return undefined;
  // §21.1.3.4 — Number.prototype owns its `toLocaleString`; only the `.call`
  // spelling reaches Object.prototype's Invoke for a number.
  if (wrapper === "Number" && propAccess.name.text === "toLocaleString") return undefined;
  const brand = tryEnsureNativeProtoBrand(ctx, wrapper);
  if (brand === undefined) return undefined;
  ensureObjectRuntime(ctx);
  const applyIdx = reserveApplyClosure(ctx);
  const vecNewIdx = ensureObjVecBuilders(ctx).newIdx;
  if (ctx.funcMap.get("__reflect_get_receiver") === undefined) return undefined;
  addStringConstantGlobal(ctx, "toString");
  flushLateImportShifts(ctx, fctx);

  const recvLocal = allocLocal(fctx, `__tls_recv_${fctx.locals.length}`, EXTERNREF);
  const fnLocal = allocLocal(fctx, `__tls_fn_${fctx.locals.length}`, EXTERNREF);
  const recvType = compileExpression(ctx, fctx, recvExpr, EXTERNREF);
  if (recvType === null) fctx.body.push({ op: "ref.null.extern" });
  else if (recvType.kind !== "externref") coerceType(ctx, fctx, recvType, EXTERNREF);
  fctx.body.push({ op: "local.set", index: recvLocal });
  // fn = GetV(recv, "toString") — the wrapper prototype, receiver = the primitive
  if (!emitLazyNativeProtoGet(ctx, fctx, brand)) fctx.body.push({ op: "ref.null.extern" });
  fctx.body.push(...stringConstantExternrefInstrs(ctx, "toString"));
  fctx.body.push(
    { op: "local.get", index: recvLocal },
    { op: "call", funcIdx: ctx.funcMap.get("__reflect_get_receiver")! },
    { op: "local.set", index: fnLocal },
    // Call(fn, recv) — `__apply_closure` throws the TypeError for a non-callable
    { op: "local.get", index: fnLocal },
    { op: "local.get", index: recvLocal },
    { op: "call", funcIdx: vecNewIdx },
    { op: "call", funcIdx: ctx.funcMap.get("__apply_closure") ?? applyIdx },
  );
  return EXTERNREF;
}

/**
 * An UNTYPED receiver (`function h(v) { return v.toString(); }`) of the method
 * spelling. The generic lowering answers `ToString(v)` (`__extern_toString`),
 * which is `Invoke(v, "toString")` only while no wrapper prototype's
 * `toString` is replaced. When the source replaces one, perform the ordinary
 * dynamic method call instead — `__extern_method_call` resolves the member
 * through the value's own prototype chain (the brand companion for a
 * primitive) and calls it with the value as `this`.
 */
function tryEmitDynamicReceiverInvoke(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  recvExpr: ts.Expression,
): ValType | undefined {
  // `toString` only: `__extern_method_call` does not resolve the inherited
  // `Object.prototype.toLocaleString` for a primitive receiver (it throws), so
  // an untyped `v.toLocaleString()` keeps the generic ToString lowering.
  if (propAccess.name.text !== "toString" || recvExpr !== propAccess.expression) return undefined;
  if (ctx.oracle.staticJsTypeOf(recvExpr) !== "mixed") return undefined;
  if (!["Boolean", "Number", "String"].some((w) => sourceOverridesBuiltinPrototypeMember(expr, w, "toString"))) {
    return undefined;
  }
  const r = emitFnctorSubclassDynamicMethodCall(ctx, fctx, expr, propAccess, propAccess.name.text);
  return r === undefined || r === null || typeof r !== "object" ? undefined : (r as ValType);
}

/**
 * `<Builtin>.prototype.<m>` read as a VALUE after the source writes that member
 * (`Boolean.prototype.toString = f; Boolean.prototype.toString === f`). The
 * static read answers the identity-stable intrinsic singleton; the write went
 * to the brand companion. Read through `__extern_get` instead — its
 * `$NativeProto` arm answers the companion entry once written, else the (now
 * minted) intrinsic, so a read BEFORE the write still sees the builtin.
 */
export function tryEmitOverriddenProtoMemberRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  builtinName: string,
  brand: number,
): ValType | undefined {
  const member = expr.name.text;
  if (!ctx.protoNamedWrittenMembers.has(member) || !sourceOverridesBuiltinPrototypeMember(expr, builtinName, member)) {
    return undefined;
  }
  ensureObjectRuntime(ctx);
  addStringConstantGlobal(ctx, member);
  flushLateImportShifts(ctx, fctx);
  if (ctx.funcMap.get("__extern_get") === undefined || !emitLazyNativeProtoGet(ctx, fctx, brand)) return undefined;
  fctx.body.push(...stringConstantExternrefInstrs(ctx, member), {
    op: "call",
    funcIdx: ctx.funcMap.get("__extern_get")!,
  });
  return EXTERNREF;
}

/**
 * Is `expr` — `<Ctor>.prototype.<m>`, or a `var` initialized to exactly that —
 * a read {@link tryEmitOverriddenProtoMemberRead} serves dynamically? The
 * reflective `.call` lowering casts that value to the intrinsic closure and
 * must decline for it.
 */
export function protoMemberReadIsOverridden(ctx: CodegenContext, expr: ts.Expression): boolean {
  if (!ctx.standalone) return false;
  let read: ts.Expression = expr;
  if (ts.isIdentifier(read)) {
    const decl = ctx.oracle.valueDeclarationOf(read);
    if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return false;
    read = decl.initializer;
  }
  if (!ts.isPropertyAccessExpression(read) || !ts.isPropertyAccessExpression(read.expression)) return false;
  const proto = read.expression;
  return (
    proto.name.text === "prototype" &&
    ts.isIdentifier(proto.expression) &&
    ctx.protoNamedWrittenMembers.has(read.name.text) &&
    sourceOverridesBuiltinPrototypeMember(read, proto.expression.text, read.name.text)
  );
}

/** `<overridden member>.call(thisArg, ...args)` — Call(F, thisArg, args) on the value actually stored. */
export function emitOverriddenProtoMemberCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  fnExpr: ts.Expression,
  isCall: boolean,
): ValType | undefined {
  if (!isCall) return undefined;
  ensureObjectRuntime(ctx);
  const applyIdx = reserveApplyClosure(ctx);
  const vec = ensureObjVecBuilders(ctx);
  flushLateImportShifts(ctx, fctx);
  const pushExtern = (e: ts.Expression): void => {
    const t = compileExpression(ctx, fctx, e, EXTERNREF);
    if (t === null) fctx.body.push({ op: "ref.null.extern" });
    else if (t.kind !== "externref") coerceType(ctx, fctx, t, EXTERNREF);
  };
  pushExtern(fnExpr);
  pushExtern(expr.arguments[0]!);
  const argsLocal = allocLocal(fctx, `__ovr_args_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push(
    { op: "call", funcIdx: ctx.funcMap.get("__objvec_new") ?? vec.newIdx },
    { op: "local.set", index: argsLocal },
  );
  for (const arg of expr.arguments.slice(1)) {
    fctx.body.push({ op: "local.get", index: argsLocal });
    pushExtern(arg);
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__objvec_push") ?? vec.pushIdx });
  }
  fctx.body.push(
    { op: "local.get", index: argsLocal },
    { op: "call", funcIdx: ctx.funcMap.get("__apply_closure") ?? applyIdx },
  );
  return EXTERNREF;
}

const PRIMITIVE_WRAPPERS = new Set(["Boolean", "Number", "String", "Symbol", "BigInt"]);

/**
 * `typeof this` inside a STRICT function whose `this` the checker types as a
 * primitive wrapper interface (`Boolean.prototype.toString = function () {
 * return typeof this; }` — TS types an assigned function's `this` as the
 * assignment target's object, i.e. `Boolean`). A strict callee receives the
 * PRIMITIVE unboxed (§10.2.1.2 OrdinaryCallBindThis), so the checker's
 * "object" fold is unsound; the runtime `__typeof` reads the value. Sloppy
 * code boxes `this`, so its fold stays.
 */
export function strictWrapperThisTypeofIsDynamic(
  ctx: CodegenContext,
  operand: ts.Expression,
  tsType: ts.Type,
): boolean {
  if (!ctx.standalone || operand.kind !== ts.SyntaxKind.ThisKeyword) return false;
  const sym = tsType.symbol as ts.Symbol | undefined;
  if (sym === undefined || !PRIMITIVE_WRAPPERS.has(sym.name) || symbolShadowsBuiltinGlobal(sym)) return false;
  // the `this`-binding function: arrows are lexical, a class body is a boundary
  let fn: ts.Node | undefined = operand.parent;
  while (fn && !ts.isSourceFile(fn) && !ts.isClassLike(fn) && (!ts.isFunctionLike(fn) || ts.isArrowFunction(fn))) {
    fn = fn.parent;
  }
  return (
    fn !== undefined &&
    (ts.isFunctionExpression(fn) || ts.isFunctionDeclaration(fn)) &&
    isStrictFunction(fn, ctx.inferModuleStrictArguments)
  );
}
