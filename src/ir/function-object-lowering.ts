// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// Canonical prepared function values and ordered property calls. The AST driver
// supplies its current recursive/coercion operations; this module never imports it.
import { ts } from "../ts-api.js";
import type { IrFunctionBuilder } from "./builder.js";
import type { IrImportedCallLoweringPlan, IrTopLevelFunctionValueLoweringPlan } from "./ast-lowering-plans.js";
import type { IrFunctionMemberClosures } from "./function-member-closure-plan.js";
import { irIntrinsicFuncRef, irRuntimeFuncRef } from "./callable-bindings.js";
import { irClosureMethodReference } from "./core/closure-invocation-callables.js";
import { functionInstanceName, propertyKeyFunctionName } from "../shared/named-evaluation.js";
import { expectedArgumentCountOfParams } from "../shared/function-expected-argument-count.js";
import type { IrUnitId } from "./identity.js";
import { JS_TAG_IDS } from "./runtime/js-tag-domain.js";
import { asVal, irDynamic, irVal, type IrType, type IrValueId } from "./nodes.js";
import { demoteToLegacy, IrUnsupportedError } from "./outcomes.js";
import { describeIrType } from "./describe-ir-type.js";
import { skipOuterExpressions } from "../shared/binding-writes.js";

/** Source-owned plan values shared by top-level and lifted lowering contexts. */
export interface FunctionValueLoweringPlans {
  readonly importedCalls?: ReadonlyMap<ts.CallExpression, IrImportedCallLoweringPlan>;
  readonly topLevelFunctionValues?: ReadonlyMap<ts.Identifier, IrTopLevelFunctionValueLoweringPlan>;
  readonly functionMemberClosures?: IrFunctionMemberClosures;
}

/** Keep all own keys, read order, and plan identities when forwarding a context. */
export function projectFunctionValueLoweringPlans(source: FunctionValueLoweringPlans | undefined): {
  readonly importedCalls: FunctionValueLoweringPlans["importedCalls"];
  readonly topLevelFunctionValues: FunctionValueLoweringPlans["topLevelFunctionValues"];
  readonly functionMemberClosures: FunctionValueLoweringPlans["functionMemberClosures"];
} {
  return {
    importedCalls: source?.importedCalls,
    topLevelFunctionValues: source?.topLevelFunctionValues,
    functionMemberClosures: source?.functionMemberClosures,
  };
}

export interface FunctionObjectLoweringHost {
  readonly builder: IrFunctionBuilder;
  readonly ownerUnitId: IrUnitId;
  readonly funcName: string;
  readonly dynamicCarrierIsExternref: () => boolean;
  /**
   * (#7354 F2) The resolver's answer, read through {@link createsFunctionObjects} like the resolver's own: where
   * closures are function objects, a call through a value is the native dispatcher `js.closure.call:N`.
   */
  readonly createsFunctionObjects: () => boolean;
  /** (#7354 O1) The identifier reads the unchanged global built-in of its name (`builtin-global-binding.ts`). */
  readonly isPristineGlobal: (identifier: ts.Identifier) => boolean;
  readonly requireOwner: (ownerUnitId: IrUnitId) => void;
  readonly lowerExpression: (source: ts.Expression) => IrValueId;
  readonly boxConcrete: (value: IrValueId, type: IrType, source: ts.Expression) => IrValueId | null;
  readonly symbols: {
    readonly IR_DYN_CALL_BOX_FN: string;
    readonly IR_DYN_CALL_VALUE_FN: string;
    readonly IR_DYN_CALL_ARGUMENT_FN: string;
  };
}

/**
 * (#3214 B1) Read/create the canonical cached wrapper for one exact bare
 * top-level function-value site.  The codegen planning phase has already
 * materialized the matching symbolic trampoline/global declarations through
 * `ensureFuncClosureSingleton`; IR owns only the lazy access sequence.
 */
export function lowerTopLevelFunctionValue(
  plan: IrTopLevelFunctionValueLoweringPlan,
  cx: FunctionObjectLoweringHost,
): IrValueId {
  cx.requireOwner(plan.ownerUnitId);
  if (plan.target.binding.kind !== "unit") {
    // invariant (producer-promise): identity resolution promised an exact unit — #4502.
    throw new Error(`ir/from-ast: top-level function value target ${plan.target.name} is not an exact unit`);
  }
  if (plan.trampoline.binding.kind !== "support") {
    // invariant (producer-promise): the prepared trampoline plan promised a compiler-support binding — #4502.
    throw new Error(`ir/from-ast: function-value trampoline ${plan.trampoline.name} is not compiler support`);
  }
  if (plan.accessor) {
    if (plan.accessor.binding.kind !== "support") {
      throw new Error(`ir/from-ast: function-value accessor ${plan.accessor.name} is not compiler support`);
    }
    const value = cx.builder.emitCall(plan.accessor, [], { kind: "callable", signature: plan.signature });
    if (value === null) throw new Error(`ir/from-ast: function-value accessor returned void (${cx.funcName})`);
    if (!plan.objectReceiver) return value;
    const dynamic = cx.builder.emitCall(irRuntimeFuncRef(cx.symbols.IR_DYN_CALL_BOX_FN), [value], irDynamic());
    if (dynamic === null) throw new Error("function-object projection returned void");
    return dynamic;
  }
  const cache = plan.cacheGlobal;
  const cached = cx.builder.emitGlobalGet(cache, irVal({ kind: "externref" }));
  const isNull = cx.builder.emitRefIsNull(cached);
  const thenBody = cx.builder.collectBodyInstrs(() => {
    const closure = cx.builder.emitClosureNew(plan.trampoline, plan.signature, [], []);
    const external = cx.builder.emitCoerceToExternref(closure);
    cx.builder.emitGlobalSet(cache, external);
  });
  cx.builder.emitIfStmt({ cond: isNull, then: thenBody, else: [] });
  // `callable<S>` is the source boundary type and lowers to the exact same
  // externref global carrier. Retagging the final read avoids an unsound
  // externref→closure cast while preserving singleton identity.
  return cx.builder.emitGlobalGet(cache, { kind: "callable", signature: plan.signature });
}

/**
 * (#7354 F1b) A Prepared source function is a function object from its creation on: `js.object.init-function` gives
 * the fresh `closure`'s bag its `length` (OrdinaryFunctionCreate, the §15.1.5 count the legacy metadata uses), `name`
 * (SetFunctionName, codegen's §10.2.9 answer) and, for a constructor (a function declaration or expression),
 * MakeConstructor's `prototype`. Every site that creates a function value calls this once, right after `closure.new`
 * (a closure literal, a declaration's value), so the bag is filled once however often the closure later becomes a
 * dynamic value, and no function value reaches the kernel without one. (#7354 O2) An object literal's accessor is
 * one too (`Object.getOwnPropertyDescriptor` reads it): named `get k` / `set k`, not a constructor.
 * A function whose name is a computed key the compiler cannot evaluate refuses by name.
 */
export function emitFunctionObjectInit(
  builder: IrFunctionBuilder,
  closure: IrValueId,
  fn: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration | ts.AccessorDeclaration,
): void {
  const key =
    ts.isMethodDeclaration(fn) || ts.isAccessor(fn) ? propertyKeyFunctionName(fn.name) : functionInstanceName(fn);
  const name = key === undefined ? key : (ts.isGetAccessor(fn) ? "get " : ts.isSetAccessor(fn) ? "set " : "") + key;
  if (name === undefined)
    throw new IrUnsupportedError(
      "type-resolution-unsupported",
      "build",
      "the name of a function under a computed key needs the key's value",
    );
  const type = builder.typeOf(closure);
  // invariant (producer-promise): callers pass the value `closure.new` just produced — #4502.
  if (type.kind !== "closure") throw new Error("ir/function-object-lowering: function object init needs its closure");
  const isConstructor = ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn);
  builder.emitCall(
    irIntrinsicFuncRef("js.object.init-function"),
    [
      builder.emitCoerceToExternref(builder.emitCallablePack(closure, type.signature)),
      builder.emitCoerceToExternref(builder.emitStringConst(name)),
      builder.emitConst({ kind: "f64", value: expectedArgumentCountOfParams(fn.parameters) }, irVal({ kind: "f64" })),
      builder.emitConst({ kind: "bool", value: isConstructor }, irVal({ kind: "i32", boolean: true })),
    ],
    null,
  );
}

/**
 * (#7354 F1b) Whether a closure is a function value with properties on this lane: the Prepared native dynamic lane
 * with native strings (`source-dynamic-contracts.ts`). There every closure literal that can become a value is created
 * as a function object (`emitFunctionObjectInit`) and may be stored as a member.
 */
export function createsFunctionObjects(resolver: { createsFunctionObjects?(): boolean } | undefined): boolean {
  return resolver?.createsFunctionObjects?.() === true;
}

export function functionObjectDynamicValue(
  value: IrValueId,
  source: ts.Expression,
  cx: FunctionObjectLoweringHost,
): IrValueId {
  let type = cx.builder.typeOf(value);
  if (type.kind === "dynamic") return value;
  if (type.kind === "closure") {
    value = cx.builder.emitCallablePack(value, type.signature);
    type = cx.builder.typeOf(value);
  }
  const primitive = cx.boxConcrete(value, type, source);
  if (primitive !== null) return primitive;
  if (
    type.kind === "callable" ||
    type.kind === "object" ||
    type.kind === "class" ||
    type.kind === "extern" ||
    asVal(type)?.kind === "externref" ||
    asVal(type)?.kind === "ref" ||
    asVal(type)?.kind === "ref_null"
  ) {
    const external = type.kind === "callable" ? value : cx.builder.emitCoerceToExternref(value);
    const dynamic = cx.builder.emitCall(irRuntimeFuncRef(cx.symbols.IR_DYN_CALL_BOX_FN), [external], irDynamic());
    if (dynamic === null) throw new Error("function-object value projection returned void");
    return dynamic;
  }
  demoteToLegacy(
    "operand-coercion-unsupported",
    `ir/from-ast: function member operand has no canonical carrier (${cx.funcName})`,
  );
}

/**
 * A concrete value for a dynamic parameter, return or argument crosses the same explicit carrier boundary as a
 * concrete equality operand (#2949 S5.P): the canonical tag-aware boxer, and (#7320) a closure boxes as a function
 * value (`functionObjectDynamicValue`). (#7354 O1c) Where closures are function objects, a raw externref (a #7128
 * open-carrier local) boxes as it is: the legalization proves its kind from its definition (`carrierKindOf`) and
 * refuses one it cannot. A value with no box (an ambiguous ref or i32) is returned as it is, so the caller's
 * assignability check refuses it.
 */
export function concreteIntoDynamic(
  value: IrValueId,
  source: ts.Expression,
  cx: FunctionObjectLoweringHost,
): IrValueId {
  const type = cx.builder.typeOf(value);
  if (type.kind === "dynamic") return value;
  const boxed =
    type.kind === "closure"
      ? functionObjectDynamicValue(value, source, cx)
      : asVal(type)?.kind === "externref" && createsFunctionObjects(cx)
        ? cx.builder.emitBox(value, irDynamic())
        : cx.boxConcrete(value, type, source);
  return boxed ?? value;
}

/**
 * A dynamic member store's key or value, or (#7354 C2) a dynamic construct's argument (`role`), onto the carrier: a
 * concrete value boxed, and (#7354 F1b) where closures are function values ({@link createsFunctionObjects}) a closure
 * as its function value. A value with no carrier refuses by name.
 */
export function dynamicStoreOperand(
  value: IrValueId,
  source: ts.Expression,
  cx: FunctionObjectLoweringHost,
  role: "member-store" | "construct argument" | "Object static argument",
): IrValueId {
  const type = cx.builder.typeOf(value);
  if (type.kind === "dynamic") return value;
  const boxed = createsFunctionObjects(cx)
    ? concreteIntoDynamic(value, source, cx)
    : cx.boxConcrete(value, type, source);
  if (boxed !== null && cx.builder.typeOf(boxed).kind === "dynamic") return boxed;
  throw new IrUnsupportedError(
    "operand-coercion-unsupported",
    "build",
    `ir/from-ast: dynamic ${role} operand of ${describeIrType(type)} has no dynamic carrier (${cx.funcName})`,
  );
}

/**
 * (#7106 S3a, #7354 C2) `new C(…args)` through a value: the callee, then each argument in source order as a dynamic
 * value, then `dyn.construct`, which the Prepared legalization (`dynamic-function-operations.ts`) or the ordinary
 * pipeline's resolver lowers. A spread argument refuses.
 */
export function lowerDynamicConstruct(expr: ts.NewExpression, cx: FunctionObjectLoweringHost): IrValueId {
  const callee = cx.lowerExpression(expr.expression);
  if (cx.builder.typeOf(callee).kind !== "dynamic") {
    throw new IrUnsupportedError(
      "constructor-resolution-unsupported",
      "build",
      `ir/from-ast: dynamic construct callee "${expr.expression.getText()}" lost its carrier (${cx.funcName})`,
    );
  }
  const args = (expr.arguments ?? []).map((argument) => {
    if (ts.isSpreadElement(argument)) {
      throw new IrUnsupportedError(
        "constructor-arity-unsupported",
        "build",
        `ir/from-ast: dynamic construct spread argument escaped selection (${cx.funcName})`,
      );
    }
    return dynamicStoreOperand(cx.lowerExpression(argument), argument, cx, "construct argument");
  });
  return cx.builder.emitDynConstruct(callee, args);
}

/**
 * (#7106, #7354 C2) The generic `value instanceof target` over two dynamic values: the left operand, then the right,
 * each a dynamic value (a concrete one boxed), then `dyn.instanceof`.
 */
export function lowerDynamicInstanceOf(expr: ts.BinaryExpression, cx: FunctionObjectLoweringHost): IrValueId {
  const value = concreteIntoDynamic(cx.lowerExpression(expr.left), expr.left, cx);
  const target = concreteIntoDynamic(cx.lowerExpression(expr.right), expr.right, cx);
  if (cx.builder.typeOf(value).kind !== "dynamic" || cx.builder.typeOf(target).kind !== "dynamic") {
    demoteToLegacy(
      "operand-coercion-unsupported",
      `ir/from-ast: dynamic instanceof operand lost its dynamic carrier (${cx.funcName})`,
    );
  }
  return cx.builder.emitDynInstanceOf(value, target);
}

export function lowerFunctionObjectMemberCall(
  expr: ts.CallExpression,
  access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  cx: FunctionObjectLoweringHost,
): IrValueId {
  return lowerDynamicMemberCall(expr, access, () => cx.lowerExpression(access.expression), cx);
}

/**
 * `recv.m(…)` / `recv[k](…)`: the receiver evaluated once, the member's [[Get]], then the call through its value with
 * the receiver as `this` (§13.3.6.1 EvaluateCall: the callee is got before the arguments are evaluated). (#7354 F2) On
 * the Prepared lane every dynamic receiver's method call takes this path; a receiver that is not yet the dynamic value
 * (an element-access call's) is put into it first.
 */
export function lowerDynamicMemberCall(
  expr: ts.CallExpression,
  access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  lowerReceiver: () => IrValueId,
  cx: FunctionObjectLoweringHost,
): IrValueId {
  refuseCallShape(
    expr,
    access.questionDotToken !== undefined,
    "method-call-unsupported",
    "optional/spread function-object member call is unsupported",
    cx,
  );
  const value = lowerReceiver();
  const receiver = createsFunctionObjects(cx) ? functionObjectDynamicValue(value, access.expression, cx) : value;
  const keySource = ts.isPropertyAccessExpression(access) ? undefined : access.argumentExpression;
  const key = keySource
    ? functionObjectDynamicValue(cx.lowerExpression(keySource), keySource, cx)
    : cx.builder.emitBox(
        cx.builder.emitStringConst((access as ts.PropertyAccessExpression).name.text),
        irDynamic(JS_TAG_IDS.String),
      );
  const callee = cx.builder.emitDynMemberGet(receiver, key);
  return createsFunctionObjects(cx)
    ? nativeClosureCall(callee, receiver, expr.arguments, cx)
    : applyDynamicCallee(callee, receiver, expr.arguments, notCallable("Value is not callable"), cx);
}

/**
 * The Prepared lane's call through the value of a callee that is neither an identifier nor a property access: an
 * element access (`o[k](…)`, its receiver is `this`), or (#7354 T) a callee that is no Reference — outer parentheses
 * skipped, so `(o.m)()` keeps its receiver while `(0, o.m)()`, `(c ? o.m : g)()`, `(o.m = g)()`, `f()()` and an IIFE
 * do not (§13.3.6.1) — called with `this` undefined as {@link lowerBindingCall} does. `undefined` elsewhere.
 */
export function lowerPreparedValueCallee(
  expr: ts.CallExpression,
  lane: { createsFunctionObjects?(): boolean } | undefined,
  host: () => FunctionObjectLoweringHost,
): IrValueId | undefined {
  if (!createsFunctionObjects(lane)) return undefined;
  const callee = skipOuterExpressions(expr.expression);
  if (ts.isElementAccessExpression(expr.expression))
    return lowerFunctionObjectMemberCall(expr, expr.expression, host());
  if (ts.isIdentifier(callee) || ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))
    return undefined;
  return lowerBindingCall(expr, undefined, host());
}

/**
 * (#7106 Stage 4) `f(…)` through a binding that holds a dynamic value (`func()` in assert.js's `assert.throws`): a
 * dynamic local or parameter, or a script `var`'s dynamic home (`scriptVar`, its declaration). No Reference base, so
 * thisArgument is `undefined` (§13.3.6.2). The callee is evaluated first, then the arguments, then IsCallable.
 * (#7354 F2) On the Prepared lane that is the native dispatcher's call (`nativeClosureCall`); on the ordinary pipeline
 * it is legacy's bare dynamic call — its `called value is not a function` TypeError, whose text the declaration picks
 * ({@link scriptVarCalleeNotCallableMessages}), and `__apply_closure` installing the undefined receiver as
 * `__current_this` for the callee's duration, as legacy's bare-call receiver reset does.
 */
export function lowerBindingCall(
  expr: ts.CallExpression,
  scriptVar: ts.Declaration | undefined,
  cx: FunctionObjectLoweringHost,
): IrValueId {
  // (#7354 C2) A local's closure is called as its function value.
  const callee = functionObjectDynamicValue(cx.lowerExpression(expr.expression), expr.expression, cx);
  if (cx.builder.typeOf(callee).kind !== "dynamic")
    demoteToLegacy("call-resolution-unsupported", `ir/from-ast: dynamic callee lost its carrier in ${cx.funcName}`);
  refuseCallShape(expr, false, "call-resolution-unsupported", "optional/spread dynamic value call is unsupported", cx);
  const receiver = cx.builder.emitDynUndefined();
  return createsFunctionObjects(cx)
    ? nativeClosureCall(callee, receiver, expr.arguments, cx)
    : applyDynamicCallee(callee, receiver, expr.arguments, scriptVarCalleeNotCallableMessages(scriptVar), cx);
}

/** An optional call, or (#7354 F2: by its own name on the Prepared lane) a spread argument, has no call through a value. */
function refuseCallShape(
  expr: ts.CallExpression,
  optionalAccess: boolean,
  reason: "method-call-unsupported" | "call-resolution-unsupported",
  text: string,
  cx: FunctionObjectLoweringHost,
): void {
  const spread = expr.arguments.some(ts.isSpreadElement);
  if (!optionalAccess && !expr.questionDotToken && !spread) return;
  demoteToLegacy(
    reason,
    createsFunctionObjects(cx) && spread
      ? `ir/from-ast: call through a value with a spread argument (${cx.funcName})`
      : text,
  );
}

const NOT_A_FUNCTION = "called value is not a function";

/** The TypeError text for a callee that is null/undefined, and for any other non-callable value. */
interface NotCallableMessages {
  readonly nullish: string;
  readonly other: string;
}

function notCallable(message: string): NotCallableMessages {
  return { nullish: message, other: message };
}

/**
 * (#7287) Legacy's TypeError text when a script `var` callee is not callable.
 * A `var` initialized with a function expression or an arrow compiles to a
 * typed closure call, whose null check reads "Cannot access property on null
 * or undefined" when the slot holds null or undefined (before initialization,
 * after `p = null`). Any other non-callable value, and every other `var`,
 * takes the generic dynamic call's text (legacy traps on `p = 5`; this throws
 * the TypeError node throws).
 */
function scriptVarCalleeNotCallableMessages(declaration: ts.Declaration | undefined): NotCallableMessages {
  const initializer = declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined;
  return initializer !== undefined && (ts.isFunctionExpression(initializer) || ts.isArrowFunction(initializer))
    ? { nullish: "Cannot access property on null or undefined", other: NOT_A_FUNCTION }
    : notCallable(NOT_A_FUNCTION);
}

function applyDynamicCallee(
  callee: IrValueId,
  receiver: IrValueId,
  argumentSources: readonly ts.Expression[],
  notCallableMessages: NotCallableMessages,
  cx: FunctionObjectLoweringHost,
): IrValueId {
  const args = cx.builder.emitCall(irRuntimeFuncRef("__objvec_new"), [], irVal({ kind: "externref" }));
  if (args === null) throw new Error("native argument vector returned void");
  for (const argument of argumentSources) {
    const value = functionObjectDynamicValue(cx.lowerExpression(argument), argument, cx);
    const external = cx.builder.emitCall(
      irRuntimeFuncRef(cx.symbols.IR_DYN_CALL_ARGUMENT_FN),
      [value],
      irVal({ kind: "externref" }),
    );
    if (external === null) throw new Error("native argument projection returned void");
    cx.builder.emitCall(irRuntimeFuncRef("__objvec_push"), [args, external], null);
  }
  const externalCallee = cx.builder.emitCall(
    irRuntimeFuncRef(cx.symbols.IR_DYN_CALL_VALUE_FN),
    [callee],
    irVal({ kind: "externref" }),
  );
  const externalReceiver = cx.builder.emitCall(
    irRuntimeFuncRef(cx.symbols.IR_DYN_CALL_VALUE_FN),
    [receiver],
    irVal({ kind: "externref" }),
  );
  if (externalCallee === null || externalReceiver === null) throw new Error("native call projection returned void");
  const callable = cx.builder.emitCall(irRuntimeFuncRef("__is_callable"), [externalCallee], irVal({ kind: "i32" }));
  if (callable === null) throw new Error("native callable classifier returned void");
  const throwNotCallable = (text: string) =>
    cx.builder.collectBodyInstrs(() => {
      const message = cx.builder.emitCoerceToExternref(cx.builder.emitStringConst(text));
      const error = cx.builder.emitCall(irRuntimeFuncRef("__new_TypeError"), [message], irVal({ kind: "externref" }));
      if (error === null) throw new Error("native TypeError constructor returned void");
      cx.builder.emitThrow(error);
    });
  const refusal =
    notCallableMessages.nullish === notCallableMessages.other
      ? throwNotCallable(notCallableMessages.other)
      : cx.builder.collectBodyInstrs(() => {
          const nullish = cx.builder.emitBinary(
            "i32.or",
            cx.builder.emitTagTest(callee, JS_TAG_IDS.Undefined),
            cx.builder.emitTagTest(callee, JS_TAG_IDS.Null),
            irVal({ kind: "i32" }),
          );
          cx.builder.emitIfStmt({
            cond: nullish,
            then: throwNotCallable(notCallableMessages.nullish),
            else: throwNotCallable(notCallableMessages.other),
          });
        });
  cx.builder.emitIfStmt({
    cond: cx.builder.emitUnary("i32.eqz", callable, irVal({ kind: "i32" })),
    then: refusal,
    else: [],
  });
  const result = cx.builder.emitCall(
    irRuntimeFuncRef("__apply_closure"),
    [externalCallee, externalReceiver, args],
    irVal({ kind: "externref" }),
  );
  if (result === null) throw new Error("native closure application returned void");
  const dynamic = cx.builder.emitCall(irRuntimeFuncRef(cx.symbols.IR_DYN_CALL_BOX_FN), [result], irDynamic());
  if (dynamic === null) throw new Error("function-object call result projection returned void");
  return dynamic;
}

/**
 * (#7354 F2) The Prepared lane's call through a value: the arguments in source order (after the callee, which the
 * caller evaluated), each as a dynamic value, and one `js.closure.call:N(receiver, callee, …args)`. The native
 * dispatcher installs `receiver` as `__current_this` for the call, pads missing arguments with `undefined` and drops
 * extra ones by the callee's arity, and throws its catchable TypeError for a value that is not a source closure. Its
 * result is a dynamic value whose kind only the callee knows.
 */
function nativeClosureCall(
  callee: IrValueId,
  receiver: IrValueId,
  argumentSources: readonly ts.Expression[],
  cx: FunctionObjectLoweringHost,
): IrValueId {
  const { builder } = cx;
  const args = argumentSources.map((argument) =>
    builder.emitCoerceToExternref(functionObjectDynamicValue(cx.lowerExpression(argument), argument, cx)),
  );
  const result = builder.emitCall(
    irClosureMethodReference(args.length),
    [builder.emitCoerceToExternref(receiver), builder.emitCoerceToExternref(callee), ...args],
    irDynamic(),
  );
  // invariant (producer-promise): the dispatcher's contract has a result — #4502.
  if (result === null) throw new Error("native closure call returned void");
  return result;
}

/** The same per-AST proof is required on expression and discarded call paths. */
export function isPreparedFunctionObjectAccess(
  access: ts.Expression,
  plans: ReadonlyMap<ts.Identifier, IrTopLevelFunctionValueLoweringPlan> | undefined,
): access is ts.PropertyAccessExpression | ts.ElementAccessExpression {
  return (
    (ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access)) &&
    ts.isIdentifier(access.expression) &&
    plans?.get(access.expression)?.objectReceiver === true
  );
}

/**
 * (#7106 census arm 3) `F.p.x = v`: the receiver `F.p` is a dynamic member get
 * on the planned, boxed function object `F`, so the write is the same dynamic
 * member write as `F.x = v`.
 */
export function isPreparedFunctionObjectChainedWrite(
  receiver: ts.Expression,
  plans: ReadonlyMap<ts.Identifier, IrTopLevelFunctionValueLoweringPlan> | undefined,
): boolean {
  return (
    ts.isPropertyAccessExpression(receiver) &&
    ts.isIdentifier(receiver.expression) &&
    plans?.get(receiver.expression)?.objectReceiver === true
  );
}

export function lowerFunctionObjectPropertyWrite(
  receiver: IrValueId,
  name: string,
  source: ts.Expression,
  cx: FunctionObjectLoweringHost,
): IrValueId {
  if (cx.dynamicCarrierIsExternref()) {
    const key = cx.builder.emitCoerceToExternref(cx.builder.emitStringConst(name));
    const result = cx.lowerExpression(source);
    const value = functionObjectDynamicValue(result, source, cx);
    const externalReceiver = cx.builder.emitCall(
      irRuntimeFuncRef(cx.symbols.IR_DYN_CALL_VALUE_FN),
      [receiver],
      irVal({ kind: "externref" }),
    );
    const externalValue = cx.builder.emitCall(
      irRuntimeFuncRef(cx.symbols.IR_DYN_CALL_VALUE_FN),
      [value],
      irVal({ kind: "externref" }),
    );
    if (externalReceiver === null || externalValue === null) throw new Error("native write projection returned void");
    cx.builder.emitCall(irRuntimeFuncRef("__extern_set_strict"), [externalReceiver, key, externalValue], null);
    return result;
  }
  const key = cx.builder.emitBox(cx.builder.emitStringConst(name), irDynamic(JS_TAG_IDS.String));
  const result = cx.lowerExpression(source);
  const value = functionObjectDynamicValue(result, source, cx);
  cx.builder.emitDynMemberSet(receiver, key, value);
  return result;
}
