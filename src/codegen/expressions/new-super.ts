import type { FieldDef, Instr, ValType } from "../../ir/types.js";
import { materializeFnctorTwinCaptures } from "../fnctor-twin-captures.js";
import { emitLayoutSelectingStructNew, maybeEmitLayoutHint } from "../fnctor-layout-emit.js"; // (#3927) per-type layouts
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * new/super/class expression compilation.
 */
import { forEachChild, ts } from "../../ts-api.js";
import {
  collectReferencedIdentifiers,
  collectWrittenIdentifiers,
  emitFuncRefAsClosure,
  isOwnParamName,
} from "../closures.js";
import { installFrameTrap } from "../frame-trap.js";
import { initializeFunctionPoisonPillContext } from "../function-poison-pill.js";
import { needsImplicitArgumentsObject } from "../helpers/body-uses-arguments.js";
import { emitFnctorCtorArgumentsObject, fnctorCtorNeedsArguments } from "../fnctor-ctor-arguments.js";
import {
  provablyNonConstructableStatically,
  resolvesToAmbientGlobal,
  resolvesToNonConstructableValue,
} from "./non-constructable.js"; // (#4017)
import { tryNonConstructableNewTarget } from "./new-non-constructable-value.js"; // (#4246)
import { reportError } from "../context/errors.js";
import { allocLocal, allocTempLocal, getLocalType, releaseTempLocal } from "../context/locals.js";
import { fnctorBodyMayReturnForeignObject } from "../fnctor-foreign-return.js"; // (#2071)
import type { CodegenContext, FunctionContext } from "../context/types.js";
import {
  addFuncType,
  addStringConstantGlobal,
  addUnionImports,
  ensureExnTag,
  getArrTypeIdxFromVec,
  getOrRegisterRefCellType,
  getOrRegisterResizableAbType,
  getOrRegisterVecType,
  resolveWasmType,
  TYPED_ARRAY_NAMES,
  typedArrayVecStorage,
} from "../index.js";
import { coercionPlan } from "../coercion-plan.js"; // (#2934 1c) single coercion table for the copy-ctor element bridge
import {
  emitDynamicTaViewConstruct,
  emitTaDynCtorConstructFromLocals,
  emitTaViewConstruct,
  emitTaViewConstructWindowed,
  getOrRegisterDvWindowType,
} from "../dataview-native.js"; // (#2159/#38) DataView windowing wrapper; (#3054 B1/B2) shared-backing TA views + windowing; (#3054 D) dynamic ctor construct
import { emitBoundsCheckedArrayGet } from "../array-methods.js";
import { emitObjectCoercion } from "./calls-guards.js"; // (#3118) shared Object(...) / new Object(...) ToObject coercion
import { COLLECTION_KIND, ensureMapHelpers, coerceMapKeyToAnyref } from "../map-runtime.js";
import { ensureDisposableStackNew } from "../disposable-runtime.js";
import { emitSetNewTargetBeforeCall, ensureNewTargetGlobal } from "../new-target.js"; // (#2023)
import {
  ensureNativeProxyRuntime,
  ensureObjectRuntime,
  ensureObjVecBuilders,
  reserveApplyClosure,
} from "../object-runtime.js"; // (#1100) standalone Proxy native runtime; (#2928) Function-marker construct
import { ensureSetHelpers } from "../set-runtime.js";
import { ensureWeakCollectionHelpers } from "../weak-collections-runtime.js";
import { tryCompileNativeWeakRefNew } from "../weakref-runtime.js";
import { classMemberFuncKey } from "../class-member-keys.js"; // (#1983) collision-free class-member funcMap keys
import { compileObjectLiteralAsExternref, resolveComputedKeyExpression } from "../literals.js";
import { stringConstantExternrefInstrs, ensureAnyToStringHelper } from "../native-strings.js";
import { MAX_NATIVE_CONSTRUCT_ARITY, reserveNativeConstructDriver } from "../native-construct.js"; // (#3981)
import { emitBoundConstructOnNull } from "../construct-bound.js"; // (#4196) §10.4.1.2
import { emitRuntimeEvalConstructOnNull } from "../runtime-eval-construct.js"; // (#4438) §10.2.2
import { emitNativeNumberFormat } from "../number-format-native.js";
import {
  compileStandaloneRegExpConstructor,
  isGlobalRegExpIdentifier,
  isGlobalRegExpType,
} from "../regexp-standalone.js";
import { emitStandaloneTest262Error, emitWasiErrorConstructor, isWasiErrorName } from "../registry/error-types.js";
import type { InnerResult } from "../shared.js";
import {
  emitDynamicNewFunctionHostEval,
  emitStandaloneDynamicFunctionStub,
  isGlobalFunctionIdentifier,
  resolvesToGlobalFunctionAlias,
  tryStaticNewFunction,
} from "./eval-inline.js";
import {
  coerceType,
  compileExpression,
  compileStatement,
  registerCompileSuperElementAccess,
  registerCompileSuperPropertyAccess,
  resolveEnclosingClassName,
} from "../shared.js";
import { hoistFunctionDeclarations, maybeSetArgcForKnownCall } from "../statements/nested-declarations.js";
import { beginNestedFunctionNameScope, endNestedFunctionNameScope } from "../nested-function-name-scope.js"; // (#4456/#2071)
import { compileStringLiteral } from "../string-ops.js";
import { coerceType as coerceTypeImpl, pushDefaultValue } from "../type-coercion.js";
import { ensureDateDaysFromCivilHelper, ensureDateStruct } from "./builtins.js";
import { emitNativeDateParse } from "../date-parse-native.js"; // (#2164) pure-Wasm new Date(str)
import { compileSpreadCallArgs } from "./extern.js";
import { compileTemporalNewExpression } from "../temporal-native.js";
import {
  emitThrowReferenceError,
  emitThrowTypeError,
  getFuncParamTypes,
  getWasmFuncReturnType,
  isEffectivelyVoidReturn,
  maybeStampCompiledFunctionArgName,
  noJsHost,
  wasmFuncReturnsVoid,
} from "./helpers.js";
import { localGlobalIdx } from "../registry/imports.js";
import { ensureLateImport, flushLateImportShifts } from "./late-imports.js";
import { NEW_GLOBAL_FALLTHROUGH, tryCompileBuiltinGlobalNew } from "./new-builtin-globals.js"; // (#3281 slice 1) built-in global ctor dispatch
import { NEW_INDEXED_FALLTHROUGH, tryCompileIndexedBuiltinNew } from "./new-indexed.js"; // (#3281 slice 2) indexed builtin ctor dispatch
import { emitFnctorProtoGet, resolveUserFnctorName } from "./fnctor-prototype.js"; // (#2660 S3a) reconstruct `new F()` as $Object; (#3981) proto for a value-bound ctor
import { emitStandalonePromiseFromExecutor, emitStandalonePromiseFromExecutorValue } from "../promise-executor.js"; // (#2959 / #2903 R1) native new Promise(executor)
import { deriveFnctorFields, resolveFnctorSymbol, resolveEnclosingFnctorOwner } from "../fnctor-escape-gate.js"; // (#2660 S3a) canonical fnctor-name key; (#2773 S1) shared field derivation; (#2681/#2686 A1) `new this()` owner
import {
  appendFnctorConstructorParam,
  emitFnctorConstructorArguments,
  emitFnctorFieldInitializers,
  fnctorCaptureLayout,
  fnctorConstructorParams,
  fnctorUserParamTypes,
  registerFnctorCaptureParams,
} from "../fnctor-constructor-identity.js";
import { funcSignatureOf, mintDefinedFunc, pushDefinedFunc } from "../func-space.js"; // (#1916 S2 read chokepoint / S3b stable-regime minting)

// #2146: resolveEnclosingClassName now lives in shared.ts (imported above).

function valTypeMatches(a: ValType, b: ValType): boolean {
  if (a.kind !== b.kind) return false;
  if ((a.kind === "ref" || a.kind === "ref_null") && (b.kind === "ref" || b.kind === "ref_null")) {
    return a.typeIdx === b.typeIdx;
  }
  return true;
}

/**
 * (#2164) Is `arg` statically a String value? `new Date(value)` parses a String
 * (§21.4.2.1) but ToNumbers anything else, so we only route to __date_parse when
 * the arg is a string literal or has a string-like static type. Anything else
 * (number, Date, any) keeps the existing ToNumber(ms) path.
 */
export function isStringTypedArg(ctx: CodegenContext, arg: ts.Expression): boolean {
  if (ts.isStringLiteralLike(arg) || ts.isTemplateExpression(arg)) return true;
  try {
    const t = ctx.checker.getTypeAtLocation(arg);
    // StringLike covers string, string literal types, and unions thereof.
    return (t.flags & ts.TypeFlags.StringLike) !== 0;
  } catch {
    return false;
  }
}

function compileCtorArgument(ctx: CodegenContext, fctx: FunctionContext, arg: ts.Expression, expected?: ValType): void {
  const result = compileExpression(ctx, fctx, arg, expected);
  if (result === null) {
    if (expected) pushDefaultValue(fctx, expected, ctx);
    return;
  }
  if (expected && !valTypeMatches(result, expected)) {
    coerceType(ctx, fctx, result, expected);
  }
}

function evaluateCtorExtraArgument(ctx: CodegenContext, fctx: FunctionContext, arg: ts.Expression): void {
  const result = compileExpression(ctx, fctx, arg);
  if (result !== null) {
    fctx.body.push({ op: "drop" });
  }
}

/**
 * (#4017) Emit the ECMA-262 `TypeError` for `new <value-with-no-[[Construct]]>`
 * when non-constructability was decided at COMPILE time, so no runtime
 * `IsConstructor` probe (and therefore no `__construct` host import) is needed.
 *
 * This is what standalone/WASI lacked. The `resolvesToNonConstructableValue`
 * guard was gated `!noJsHost` because its *vehicle* is the `__construct` host
 * import; in standalone that discarded the vehicle AND the proof, and control
 * fell through to the terminal `__new_<name>` lookup, found no import, and
 * emitted a bare `ref.null.extern` — so `new (String.prototype.charAt)` quietly
 * evaluated to null instead of throwing (test262 `S15.5.4.*_A7`, 10 files, all
 * of which the host lane already passed).
 *
 * `args` are compiled-and-dropped first: §13.3.5.1 EvaluateNew evaluates the
 * MemberExpression and the ArgumentList BEFORE the IsConstructor check, so their
 * side effects must still happen. Pass `[]` where the callee form takes none.
 */
function emitStaticNotAConstructorThrow(
  ctx: CodegenContext,
  fctx: FunctionContext,
  args: readonly ts.Expression[],
): ValType {
  for (const arg of args) {
    evaluateCtorExtraArgument(ctx, fctx, ts.isSpreadElement(arg) ? arg.expression : arg);
  }
  emitThrowTypeError(ctx, fctx, "is not a constructor");
  fctx.body.push({ op: "ref.null.extern" });
  return { kind: "externref" };
}

/**
 * Is `new <callee>` a construct on something reachable through `.prototype` that
 * provably has no `[[Construct]]`? Two shapes, both throwing a real `TypeError`
 * so test262 `assert.throws(TypeError, …)` catches it (#1528):
 *
 *   - `X.prototype.Y` — a prototype METHOD; never a constructor (§9.2.2).
 *   - (#4017) `<AmbientIntrinsic>.prototype` — the prototype OBJECT itself, one
 *     level shallower. `Object.prototype` is a plain object; `Function.prototype`
 *     is a built-in function that deliberately has NO `[[Construct]]` (§20.2.3).
 *     test262 `S15.2.4_A4`, `S15.3.4_A5` — both lanes failed these.
 *
 * `resolvesToAmbientGlobal` keeps a USER `function Foo(){}; new Foo.prototype`
 * out of the second shape, since a user prototype can legitimately be assigned a
 * constructor. Do NOT also exclude `ctx.classSet` / `ctx.externClasses`: the
 * callee is the `.prototype` OBJECT, never the class itself, so a registered
 * extern class is irrelevant — and `externClasses` DOES carry `Object`
 * (extern-declarations.ts), which silently swallowed `new Object.prototype`,
 * the very case this exists for.
 */
function isNewOnNonConstructablePrototype(ctx: CodegenContext, callee: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const obj = callee.expression;
  if (ts.isPropertyAccessExpression(obj) && obj.name.text === "prototype") return true;
  return callee.name.text === "prototype" && ts.isIdentifier(obj) && resolvesToAmbientGlobal(ctx, obj);
}

/**
 * A Date prototype method reached through an instance is the same builtin
 * function object as `Date.prototype.<name>` and therefore has no
 * `[[Construct]]`. The direct-prototype guard above misses the natural
 * `new date.getYear()` spelling used by Test262. Keep this proof narrow and
 * decline it if the source writes that member anywhere; an overwritten method
 * may be an ordinary constructible function.
 */
function isNewOnUnmodifiedDateInstanceMethod(ctx: CodegenContext, callee: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const receiverType = ctx.checker.getNonNullableType(ctx.checker.getTypeAtLocation(callee.expression));
  if (receiverType.getSymbol()?.name !== "Date") return false;

  const memberName = callee.name.text;
  let reassigned = false;
  const source = callee.getSourceFile();
  const visit = (node: ts.Node): void => {
    if (reassigned) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === memberName
    ) {
      reassigned = true;
      return;
    }
    forEachChild(node, visit);
  };
  visit(source);
  return !reassigned;
}

/** Evaluate a proven non-constructor member value and arguments, then throw. */
function emitStaticMemberNotAConstructorThrow(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callee: ts.Expression,
  args: readonly ts.Expression[],
): ValType {
  const calleeType = compileExpression(ctx, fctx, callee);
  if (calleeType) fctx.body.push({ op: "drop" });
  return emitStaticNotAConstructorThrow(ctx, fctx, args);
}

/**
 * (#1632b-2 / #1528a residual) Does `new <id>(...)` target a runtime FUNCTION
 * VALUE held in a binding — `const C = makeCtor(); new C()` — that is provably
 * CONSTRUCTABLE (an ordinary `function` value, not an arrow / bound / prototype
 * method, which `resolvesToNonConstructableValue` already routes to the throwing
 * `__construct` brand check)? Such a callee is mis-classified by the unknown-ctor
 * path as an `extern_class` host import (fails at instantiation with
 * "No dependency provided for extern class …"); it must instead route through the
 * `__construct_closure` host bridge, whose `_wrapCallableForHost` construct trap
 * runs the compiled closure body (ECMA-262 §10.2.2).
 *
 * Gate strictly on the value-binding shape so no declared class, ambient/host
 * constructor (Test262Error is a top-level `FunctionDeclaration`, kept on the
 * existing path), or intrinsic ctor is intercepted:
 *  - callee is a bare identifier whose **value declaration is a
 *    `VariableDeclaration`** (a function held in a binding, not a hoisted
 *    function/class declaration);
 *  - the binding's TS type has **call signatures** (it is callable) and **no
 *    construct signatures** that would have made a static guard fire;
 *  - it is NOT a known compiled class and NOT a registered extern class.
 */
/**
 * (#3025) Syntactic fallback for `new f(...)` written INSIDE a `with` body.
 *
 * TypeScript refuses to resolve bare identifiers under a `with` (it cannot model
 * the Object Environment Record), so `getSymbolAtLocation` answers `undefined`
 * even for a `var` declared in the very same block:
 *
 *     with (myObj) { var f = function () { … }; var obj = new f(); }
 *
 * With no declaration, `resolvesToConstructableFunctionValue` declined, the
 * native-construct driver was never reserved, and the whole `S12.10_A1.8_T*` /
 * `S12.10_A3.8_T*` family died at the `new` site. Recover the declaration by
 * scanning the enclosing function (or source file) for `var <name> = function
 * (…) {…}` — the exact shape those tests use, and the only one this fallback
 * claims. Anything else (a parameter, a re-assignment, a non-function
 * initializer) yields `undefined` and the ordinary dispatch continues.
 */
function withBodyVarFunctionInitializer(callee: ts.Identifier): ts.FunctionExpression | undefined {
  let insideWith = false;
  for (let cur: ts.Node | undefined = callee; cur !== undefined; cur = cur.parent) {
    const parent: ts.Node | undefined = cur.parent;
    if (parent !== undefined && ts.isWithStatement(parent) && parent.statement === cur) {
      insideWith = true;
      break;
    }
  }
  if (!insideWith) return undefined;

  // Nearest enclosing function body (or the source file for top-level `with`).
  let scope: ts.Node | undefined = callee;
  while (
    scope !== undefined &&
    !ts.isSourceFile(scope) &&
    !ts.isFunctionDeclaration(scope) &&
    !ts.isFunctionExpression(scope) &&
    !ts.isArrowFunction(scope) &&
    !ts.isMethodDeclaration(scope) &&
    !ts.isConstructorDeclaration(scope)
  ) {
    scope = scope.parent;
  }
  if (scope === undefined) return undefined;

  let found: ts.FunctionExpression | undefined;
  let rebound = false;
  const visit = (node: ts.Node): void => {
    if (rebound) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === callee.text &&
      node.initializer !== undefined
    ) {
      let init: ts.Expression = node.initializer;
      while (ts.isParenthesizedExpression(init)) init = init.expression;
      if (
        ts.isFunctionExpression(init) &&
        init.asteriskToken === undefined &&
        !init.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
      ) {
        // A SECOND function-valued declaration of the same name is still one
        // shape; a differently-shaped rebind is not claimable.
        found = init;
      } else {
        rebound = true;
        return;
      }
    }
    // A later `f = <something else>` makes the binding's value unknowable here.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      node.left.text === callee.text
    ) {
      rebound = true;
      return;
    }
    forEachChild(node, visit);
  };
  forEachChild(scope, visit);
  return rebound ? undefined : found;
}

function resolvesToConstructableFunctionValue(ctx: CodegenContext, calleeExpr: ts.Expression): boolean {
  if (!ts.isIdentifier(calleeExpr)) return false;
  if (ctx.classSet.has(calleeExpr.text) || ctx.externClasses.has(calleeExpr.text)) return false;
  // (#3025) `with`-body callee the checker cannot resolve — see above.
  if (ctx.oracle.isUnresolvableIdentifier(calleeExpr)) {
    return withBodyVarFunctionInitializer(calleeExpr) !== undefined;
  }
  // An arrow / bound / prototype-method value is non-constructable — that is the
  // throwing path, handled by resolvesToNonConstructableValue. Do not claim it.
  if (resolvesToNonConstructableValue(ctx, calleeExpr)) return false;
  const sym = ctx.checker.getSymbolAtLocation(calleeExpr);
  const decl = sym?.valueDeclaration;
  // (#3981 follow-up, ES5 lane) PARAMETER bindings admitted alongside vars: a
  // callback receiving a constructor (`var mk = function(c){ return new c(); }`)
  // fell past every arm to the null terminal — `new c()` answered null with no
  // diagnostic, the exact gap this driver exists to close. The signature
  // discrimination below is declaration-based and applies unchanged.
  if (!decl || (!ts.isVariableDeclaration(decl) && !ts.isParameter(decl))) return false;
  const t = ctx.checker.getTypeAtLocation(calleeExpr);
  // Callable value (a function held in the binding). Construct-signature-bearing
  // values (real class ctors typed through the binding) are left to the static
  // class paths; here we target the ordinary-function-value cluster.
  const callSigs = t.getCallSignatures();
  if (callSigs.length === 0) {
    // (#3087 standalone twin) An UNTYPED parameter that receives a constructor
    // at runtime (`function mk(c) { return new c(); }` — the test262 harness
    // wrapper shape). The checker offers no signature to discriminate, but the
    // driver is runtime-dispatched: a closure constructs, and a non-closure
    // value falls through the dispatcher's ladder — today's alternative is the
    // dynamic chain's silent null, strictly worse. Parameters only: an
    // any-typed VAR keeps the existing evolving-binding routes.
    return (
      ts.isParameter(decl) && ts.isIdentifier(decl.name) && (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0
    );
  }
  // Only a PLAIN constructable function gets the closure-construct bridge.
  // Generator (`function*` / `*m()`), async, and async-generator functions, plus
  // method/accessor/arrow values, have NO [[Construct]] (§14.4.13 / §15.x): e.g.
  // `var m = { *m(){} }.m; new m()` MUST throw TypeError, not construct. The
  // bridge would wrongly construct them. The call signature's DECLARATION (kind +
  // asterisk/async modifiers) is the authoritative discriminator — a binding's
  // type otherwise loses the AST. (Regressed
  // `language/.../method-definition/generator-invoke-ctor.js` before this guard.)
  for (const sig of callSigs) {
    const sigDecl = sig.getDeclaration() as ts.SignatureDeclaration | undefined;
    if (!sigDecl) return false; // unknown shape — don't claim it
    if ("asteriskToken" in sigDecl && (sigDecl as ts.FunctionLikeDeclaration).asteriskToken) return false; // generator
    if (ts.canHaveModifiers(sigDecl) && ts.getModifiers(sigDecl)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword))
      return false; // async / async-gen
    // Only an ordinary function declaration / expression is constructable;
    // method / accessor / arrow / constructor-type signatures are not.
    if (!ts.isFunctionDeclaration(sigDecl) && !ts.isFunctionExpression(sigDecl)) return false;
  }
  return true;
}

/**
 * (#3087) Does `new <id>(...)` target a runtime constructor VALUE held in an
 * `any`/`unknown`-typed binding whose constructability cannot be decided
 * statically — most importantly a **callback PARAMETER** that receives a
 * constructor at runtime, e.g. the TypedArray harness wrapper
 * `testWithTypedArrayConstructors(function (TA) { new TA(3); … })` where `TA`
 * is the concrete `Int8Array`/… constructor passed positionally into the
 * `any`-typed callback param?
 *
 * Such a callee is mis-classified by the unknown-ctor fallthrough as a static
 * `extern_class` host import named after the local (`__new_TA`), which does not
 * exist, so instantiation/execution fails with
 * "No dependency provided for extern class 'TA'" (#3074's dominant downstream
 * honest-fail). It must instead route through the **existing** `__construct_closure`
 * host bridge, whose runtime side (runtime.ts) already handles a non-struct
 * externref host constructor value: it runs the spec IsConstructor probe
 * (`Reflect.construct(function(){}, [], value)`) and either `Reflect.construct`s
 * the value or throws the spec `TypeError` for a non-constructor — so routing an
 * `any`-typed value here is spec-safe REGARDLESS of whether the runtime value is
 * actually a constructor.
 *
 * Gate strictly so no static class, ambient/intrinsic ctor (ArrayBuffer,
 * DataView, TypedArrays, Error subclasses — handled by the explicit branches
 * that PRECEDE the placement of this check), function-constructor, or registered
 * extern class is intercepted:
 *  - callee is a bare identifier;
 *  - its value declaration is a **Parameter / VariableDeclaration / BindingElement**
 *    in a real source file (NOT a declaration-file ambient global, NOT unresolved);
 *  - its static type is `any` or `unknown` (a genuinely-dynamic ctor value —
 *    a construct-signature-bearing or callable binding is left to the static /
 *    `resolvesToConstructableFunctionValue` closure paths);
 *  - it is NOT a known compiled class, registered extern class, or function
 *    constructor.
 */
function resolvesToDynamicAnyCtorValue(ctx: CodegenContext, calleeExpr: ts.Expression): boolean {
  if (!ts.isIdentifier(calleeExpr)) return false;
  if (ctx.classSet.has(calleeExpr.text) || ctx.externClasses.has(calleeExpr.text)) return false;
  if (ctx.funcConstructorMap?.has(calleeExpr.text)) return false;
  // (#1930) Destructured-alias form for the symbol lookup (out of ratchet scope);
  // the type-flags check routes through the oracle (`typeFactOf`) rather than a
  // direct `getTypeAtLocation`.
  const { checker } = ctx;
  const sym = checker.getSymbolAtLocation(calleeExpr);
  const decl = sym?.valueDeclaration;
  if (!decl) return false;
  // Ambient globals (ArrayBuffer/DataView/TypedArrays/…) declare in lib `.d.ts` —
  // never intercept those; their explicit branches own them.
  if (decl.getSourceFile().isDeclarationFile) return false;
  if (!ts.isParameter(decl) && !ts.isVariableDeclaration(decl) && !ts.isBindingElement(decl)) return false;
  // A local selected by a conditional expression is also genuinely dynamic,
  // even when TypeScript infers a concrete union instead of `any`/`unknown`.
  // ReactDOM uses exactly this feature-detection pattern:
  //
  //   var AbortControllerLocal =
  //     typeof AbortController !== "undefined"
  //       ? AbortController
  //       : function AbortControllerFallback() { ... };
  //   new AbortControllerLocal();
  //
  // Both branches are runtime VALUES. Treating the binding name as a static
  // extern-class name requests a nonexistent `__new_AbortControllerLocal`
  // dependency. The host construct bridge performs the real IsConstructor
  // check and Reflect.construct on whichever value was selected, so it also
  // preserves the correct TypeError if a conditional branch is not
  // constructable.
  if (ts.isVariableDeclaration(decl) && decl.initializer) {
    let init: ts.Expression = decl.initializer;
    while (ts.isParenthesizedExpression(init) || ts.isAsExpression(init) || ts.isNonNullExpression(init)) {
      init = ts.isParenthesizedExpression(init)
        ? init.expression
        : ts.isAsExpression(init)
          ? init.expression
          : init.expression;
    }
    if (ts.isConditionalExpression(init)) return true;
  }
  const fact = ctx.oracle.typeFactOf(calleeExpr);
  if (fact.kind === "any" || fact.kind === "unknown") return true;
  // (#3435) A binding typed as the bare lib `Function` interface is equally a
  // DYNAMIC ctor value: under checkJs the harness JSDoc
  // (`@callback … @param {Function} TypedArrayConstructor`) contextually types
  // the callback param as `Function`, so the oracle reports `builtin:Function`
  // instead of `any` — and `new TA(3)` fell through to the non-existent
  // `__new_TA` extern-class import ("No dependency provided for extern class").
  // `Function` has no static construct signature to dispatch on; the
  // `__construct_closure` runtime IsConstructor probe is spec-correct for any
  // runtime value, so route it the same way.
  return fact.kind === "builtin" && fact.name === "Function";
}

/**
 * (#2886) The global builtin **functions** that are NOT constructors per
 * ECMA-262 §19.2 (`decodeURI`/`encodeURI`/…/`parseInt`/`parseFloat`/`isNaN`/
 * `isFinite`). Each is an ordinary built-in function object that does **not**
 * implement `[[Construct]]`, so `new <fn>()` must throw a `TypeError`
 * (§13.3.5.1 EvaluateNew step 5: `IsConstructor(constructor) === false`).
 * `eval` is intentionally omitted — it is filtered out of test262 and handled
 * elsewhere.
 */
const GLOBAL_NON_CONSTRUCTOR_FUNCTIONS = new Set([
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
]);

/**
 * (#2886) Does `id` resolve to the **ambient global** binding (declared only in
 * the TypeScript lib `.d.ts` files), rather than a user-defined shadow? A user
 * who writes `function parseInt() {}` (or `class isNaN {}`) has a declaration in
 * a real source file and *is* constructable — we must not intercept those. The
 * ambient builtin's symbol has all of its declarations in declaration files.
 * Unresolved symbols (no declaration anywhere) are treated as the global.
 */
/**
 * (#3097) JS-host lane: `new <TA>(buffer[, byteOffset[, length]])` with a
 * statically-known ArrayBuffer/SharedArrayBuffer buffer arg.
 *
 * The native vec path treats the buffer arg as a numeric LENGTH
 * (`ToNumber(vecStruct)` → NaN → `i32.trunc_sat` → 0), so
 * `new Int8Array(new ArrayBuffer(8))` produced a length-0 compiled vec. Route
 * through the host construct bridge instead: resolve the REAL host constructor
 * (`__extern_get(globalThis, "<TA>")` — the #3087 ctor-as-value pattern),
 * materialize the args into a JS argv, and `__construct_closure(ctor, argv)`.
 * The bridge's runtime side (#3097) marshals a compiled-ArrayBuffer i32_byte
 * vec struct to its canonical host ArrayBuffer (identity-cached), so the host
 * constructor builds a REAL windowed TypedArray view with byte-sharing across
 * sibling views.
 *
 * Returns a host TypedArray externref. `inferTaViewType` (variables.ts) types
 * the binding externref in LOCK-STEP with this gate so reads route through the
 * extern paths — a `ref.cast` to the native vec type would trap.
 *
 * DataView-typed buffer args are deliberately EXCLUDED (host lane): per
 * §23.2.5.1 a DataView is not a buffer — `new TA(dataView)` takes the
 * array-like path (length 0), which the existing numeric fallback already
 * approximates.
 *
 * One terminal `flushLateImportShifts` before any body emission (the
 * #608/#794 late-import index-shift hazard). Returns null when the bridge
 * imports are unavailable (caller falls through to the legacy path).
 */
export function emitHostTaBufferConstruct(
  ctx: CodegenContext,
  fctx: FunctionContext,
  className: string,
  args: readonly ts.Expression[],
): ValType | null {
  const gtIdx = ensureLateImport(ctx, "__get_globalThis", [], [{ kind: "externref" }]);
  const getIdx = ensureLateImport(
    ctx,
    "__extern_get",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  const arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
  const arrPushIdx = ensureLateImport(ctx, "__js_array_push", [{ kind: "externref" }, { kind: "externref" }], []);
  const ccIdx = ensureLateImport(
    ctx,
    "__construct_closure",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  addStringConstantGlobal(ctx, className);
  flushLateImportShifts(ctx, fctx);
  const finalGt = ctx.funcMap.get("__get_globalThis") ?? gtIdx;
  const finalGet = ctx.funcMap.get("__extern_get") ?? getIdx;
  const finalArrNew = ctx.funcMap.get("__js_array_new") ?? arrNewIdx;
  const finalArrPush = ctx.funcMap.get("__js_array_push") ?? arrPushIdx;
  const finalCc = ctx.funcMap.get("__construct_closure") ?? ccIdx;
  if (
    finalGt === undefined ||
    finalGet === undefined ||
    finalArrNew === undefined ||
    finalArrPush === undefined ||
    finalCc === undefined
  ) {
    return null;
  }
  // ctor = globalThis["<TA>"] — the genuine host constructor.
  fctx.body.push({ op: "call", funcIdx: finalGt });
  fctx.body.push(...stringConstantExternrefInstrs(ctx, className));
  fctx.body.push({ op: "call", funcIdx: finalGet });
  const ctorLocal = allocLocal(fctx, `__hta_ctor_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: ctorLocal });
  // argv = [buffer, byteOffset?, length?] — each boxed externref, source order.
  fctx.body.push({ op: "call", funcIdx: finalArrNew });
  const argvLocal = allocLocal(fctx, `__hta_argv_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: argvLocal });
  for (const arg of args) {
    fctx.body.push({ op: "local.get", index: argvLocal });
    const aTy = compileExpression(ctx, fctx, arg, { kind: "externref" });
    if (aTy && aTy.kind !== "externref") {
      coerceType(ctx, fctx, aTy, { kind: "externref" });
    } else if (aTy === null) {
      fctx.body.push({ op: "ref.null.extern" });
    }
    fctx.body.push({ op: "call", funcIdx: finalArrPush });
  }
  fctx.body.push({ op: "local.get", index: ctorLocal });
  fctx.body.push({ op: "local.get", index: argvLocal });
  fctx.body.push({ op: "call", funcIdx: finalCc });
  return { kind: "externref" };
}

/**
 * (#3097) Gate for `emitHostTaBufferConstruct` — MUST stay in lock-step with
 * `inferTaViewType`'s host-lane arm (variables.ts) so the binding's local type
 * (externref) agrees with the constructed value.
 */
export function hostTaBufferArgSymName(ctx: CodegenContext, args: readonly ts.Expression[]): string | undefined {
  if (noJsHost(ctx)) return undefined;
  if (args.length < 1 || args.length > 3 || ts.isNumericLiteral(args[0]!)) return undefined;
  const argSymName = ctx.oracle.builtinReceiverOf(args[0]!);
  if (argSymName === "ArrayBuffer" || argSymName === "SharedArrayBuffer") return argSymName;
  return undefined;
}

// (#4017) Moved to ./non-constructable.ts together with the rest of the
// "does this callee have [[Construct]]?" analysis; re-exported here because
// json-standalone.ts and new-builtin-globals.ts import it from this module.
export { resolvesToAmbientGlobal, resolvesToNamedAmbientGlobal } from "./non-constructable.js";

/** Compile super.method(args) — resolve to ParentClass_method and call with this */
/**
 * (#1614) Dispatch `super.method(args)` where the parent is a builtin extern
 * class (Set/Map/Array/...) whose methods are host-backed and therefore not
 * present in `funcMap`. Emits __extern_method_call(this, methodName, argsArray)
 * and returns externref. Returns null when the parent is not a known extern
 * class or the required host imports cannot be registered (caller then reports
 * the original "Cannot find method" error).
 */
function emitSuperExternMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  methodName: string,
  parentClassName: string,
): ValType | null {
  // Only applies when the parent (or an ancestor) is a registered extern class.
  let externAncestor: string | undefined = parentClassName;
  while (externAncestor && !ctx.externClasses.has(externAncestor)) {
    externAncestor = ctx.classParentMap.get(externAncestor);
  }
  if (!externAncestor) return null;

  // (#2029 family B) Standalone/WASI: this whole path is a JS-host bridge
  // (`__extern_method_call` + `__js_array_*` — a dynamic `recv[name](args)`
  // performed in JS land). With no host, the imports both leak (the module
  // could never instantiate with an empty import object) AND the method-name
  // string push below baked the `-1` string-global sentinel → the raw
  // "global index out of range — -1" emit crash (e.g. `super[Symbol.replace]`
  // in a `class RE extends RegExp`). Refuse here so the caller reports the
  // clean, located "Cannot find method 'X' on parent class 'Y'" error —
  // the #1888 dual-mode invariant (loud refusal, never a poisoned index).
  if (ctx.standalone || ctx.wasi) return null;

  const selfIdx = fctx.localMap.get("this");
  if (selfIdx === undefined) return null;

  const arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
  const arrPushIdx = ensureLateImport(ctx, "__js_array_push", [{ kind: "externref" }, { kind: "externref" }], []);
  const methodCallIdx = ensureLateImport(
    ctx,
    "__extern_method_call",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (arrNewIdx === undefined || arrPushIdx === undefined || methodCallIdx === undefined) return null;

  // Receiver = `this`, coerced to externref.
  fctx.body.push({ op: "local.get", index: selfIdx });
  fctx.body.push({ op: "extern.convert_any" });
  const recvLocal = allocLocal(fctx, `__super_emc_recv_${fctx.locals.length}`, {
    kind: "externref",
  });
  fctx.body.push({ op: "local.set", index: recvLocal });

  // Build args array.
  fctx.body.push({ op: "call", funcIdx: arrNewIdx });
  const argsLocal = allocLocal(fctx, `__super_emc_args_${fctx.locals.length}`, {
    kind: "externref",
  });
  fctx.body.push({ op: "local.set", index: argsLocal });

  for (const arg of expr.arguments) {
    const valueExpr = ts.isSpreadElement(arg) ? arg.expression : arg;
    fctx.body.push({ op: "local.get", index: argsLocal });
    const argType = compileExpression(ctx, fctx, valueExpr, {
      kind: "externref",
    });
    if (argType && argType.kind !== "externref") {
      fctx.body.push({ op: "extern.convert_any" });
    } else if (argType === null) {
      fctx.body.push({ op: "ref.null.extern" });
    }
    // (#3429) See maybeStampCompiledFunctionArgName — no-ops outside JS-host
    // (this whole function already refuses standalone/wasi above).
    maybeStampCompiledFunctionArgName(ctx, fctx, valueExpr);
    const finalPushIdx = ctx.funcMap.get("__js_array_push") ?? arrPushIdx;
    fctx.body.push({ op: "call", funcIdx: finalPushIdx });
  }

  // __extern_method_call(receiver, methodName, args)
  fctx.body.push({ op: "local.get", index: recvLocal });
  // (#2029 family B) Route the name push through the dual-mode helper: a raw
  // `global.get stringGlobalMap.get(name)` guarded only on `!== undefined`
  // bakes the -1 sentinel under nativeStrings (gc + --nativeStrings; the
  // standalone/wasi combination is refused above). Host mode is
  // byte-identical (the helper emits the same `global.get`).
  addStringConstantGlobal(ctx, methodName);
  fctx.body.push(...stringConstantExternrefInstrs(ctx, methodName));
  fctx.body.push({ op: "local.get", index: argsLocal });
  const finalMcIdx = ctx.funcMap.get("__extern_method_call") ?? methodCallIdx;
  fctx.body.push({ op: "call", funcIdx: finalMcIdx });
  return { kind: "externref" };
}

/**
 * (#3194) Shared super-method-dispatch core for `super.method(args)` and
 * `super['method'](args)`. The two call forms differ ONLY in how `methodName`
 * is obtained (identifier vs computed key), so both resolve through here.
 *
 * The no-class / no-parent fallbacks (super in an object-literal method, or in
 * an `extends`-less class — no statically-resolvable parent method) evaluate the
 * arguments for side effects and leave a return-typed default on the stack. That
 * is the spec-side-correct branch: the call is a value-producing expression, so
 * a value must remain. The pre-#3194 element form returned `null` WITHOUT
 * pushing a value (the divergence flagged in #1849's 2026-06-04 review); the two
 * forms are now unified on the value-leaving branch.
 */
function compileSuperMethodCallCore(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  methodName: string,
): ValType | null {
  // Degenerate fallback: evaluate args for side effects and leave a
  // return-typed default (0 / 0 / undefined) so a value remains for the
  // enclosing expression.
  const evalArgsAndDefault = (): ValType | null => {
    for (const arg of expr.arguments) {
      const argType = compileExpression(ctx, fctx, arg);
      if (argType !== null) fctx.body.push({ op: "drop" });
    }
    const fbSig = ctx.checker.getResolvedSignature(expr);
    if (!fbSig) return null;
    const wasmType = resolveWasmType(ctx, ctx.checker.getReturnTypeOfSignature(fbSig));
    if (wasmType.kind === "f64") {
      fctx.body.push({ op: "f64.const", value: 0 });
    } else if (wasmType.kind === "i32") {
      fctx.body.push({ op: "i32.const", value: 0 });
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    return wasmType;
  };

  // Determine which class we're in.
  const currentClassName = resolveEnclosingClassName(fctx);
  if (!currentClassName) return evalArgsAndDefault(); // super in object literal
  const parentClassName = ctx.classParentMap.get(currentClassName);
  if (!parentClassName) return evalArgsAndDefault(); // class without extends

  // Resolve parent method — walk up the inheritance chain.
  let ancestor: string | undefined = parentClassName;
  let funcIdx: number | undefined;
  while (ancestor) {
    funcIdx = ctx.funcMap.get(`${ancestor}_${methodName}`);
    if (funcIdx !== undefined) break;
    ancestor = ctx.classParentMap.get(ancestor);
  }

  if (funcIdx === undefined) {
    // (#1614) The parent may be a builtin extern class (Set/Map/Array/...)
    // whose methods are host-backed, not compiled into funcMap. Dispatch
    // `super.method(args)` dynamically via __extern_method_call(this, name, args).
    const externResult = emitSuperExternMethodCall(ctx, fctx, expr, methodName, parentClassName);
    if (externResult !== null) return externResult;
    reportError(ctx, expr, `Cannot find method '${methodName}' on parent class '${parentClassName}'`);
    return null;
  }

  // Push this as first argument.
  // (#3024) A STATIC method has no `this` local, so nothing is pushed here and
  // the parent's compiled function has NO receiver param either. The self offset
  // below must therefore track what we ACTUALLY pushed — hardcoding 1 made every
  // `super.m(arg)` in a static method emit a call one argument short
  // (`not enough arguments on the stack for call (need N, got N-1)` = invalid
  // Wasm): the first real arg was mis-binned as an "extra" and dropped, and the
  // pad loop started past the end so it padded nothing.
  const selfIdx = fctx.localMap.get("this");
  const pushedSelf = selfIdx !== undefined;
  if (pushedSelf) {
    fctx.body.push({ op: "local.get", index: selfIdx });
  }
  // 1 when a receiver occupies param 0, 0 in a static context (none pushed).
  const selfOffset = pushedSelf ? 1 : 0;

  // Push remaining arguments with type hints.
  const paramTypes = getFuncParamTypes(ctx, funcIdx);
  // User-visible param count excludes the receiver, when there is one.
  const superParamCount = paramTypes ? paramTypes.length - selfOffset : expr.arguments.length;
  for (let i = 0; i < expr.arguments.length; i++) {
    if (i < superParamCount) {
      compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + selfOffset]); // skip self when present
    } else {
      // Extra argument beyond method's parameter count — evaluate for
      // side effects (JS semantics) and discard the result.
      const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
      if (extraType !== null) {
        fctx.body.push({ op: "drop" });
      }
    }
  }
  // Pad missing arguments with defaults. We have filled param slots
  // [0, selfOffset + args.length), so resume there (#3024: was hardcoded +1,
  // which over-skipped one slot in a static context).
  if (paramTypes) {
    for (let i = expr.arguments.length + selfOffset; i < paramTypes.length; i++) {
      pushDefaultValue(fctx, paramTypes[i]!, ctx);
    }
  }
  // Re-lookup funcIdx: argument compilation may trigger addUnionImports.
  const resolvedName = `${ancestor}_${methodName}`;
  const finalSuperIdx = ctx.funcMap.get(resolvedName) ?? funcIdx;
  maybeSetArgcForKnownCall(ctx, fctx, resolvedName, expr.arguments.length, superParamCount);
  fctx.body.push({ op: "call", funcIdx: finalSuperIdx });

  // Determine return type.
  const sig = ctx.checker.getResolvedSignature(expr);
  if (sig) {
    const retType = ctx.checker.getReturnTypeOfSignature(sig);
    if (isEffectivelyVoidReturn(ctx, retType, resolvedName)) return null;
    if (wasmFuncReturnsVoid(ctx, finalSuperIdx)) return null;
    return getWasmFuncReturnType(ctx, finalSuperIdx) ?? resolveWasmType(ctx, retType);
  }
  return null;
}

function compileSuperMethodCall(ctx: CodegenContext, fctx: FunctionContext, expr: ts.CallExpression): InnerResult {
  const propAccess = expr.expression as ts.PropertyAccessExpression;
  return compileSuperMethodCallCore(ctx, fctx, expr, propAccess.name.text);
}

/**
 * Compile `super['method'](args)` — resolve to ParentClass_method and call with
 * this. Same logic as {@link compileSuperMethodCall}; the method name comes from
 * a computed key resolved by the caller (see compileSuperMethodCallCore).
 */
function compileSuperElementMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  methodName: string,
): ValType | null {
  return compileSuperMethodCallCore(ctx, fctx, expr, methodName);
}

/**
 * Compile `super.prop` — access a parent class property or getter via `this`.
 * For getter accessors, calls the parent's getter function.
 * For struct fields, accesses the field on `this` (child struct inherits parent fields).
 */
export function compileSuperPropertyAccess(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
): ValType | null {
  // Determine which class we're in
  const currentClassName = resolveEnclosingClassName(fctx);
  if (!currentClassName) {
    // super in object literal method — cannot resolve prototype chain at compile time.
    // Emit a default value based on the access type.
    const accessType = ctx.checker.getTypeAtLocation(expr);
    const wasmType = resolveWasmType(ctx, accessType);
    if (wasmType.kind === "f64") {
      fctx.body.push({ op: "f64.const", value: 0 });
    } else if (wasmType.kind === "i32") {
      fctx.body.push({ op: "i32.const", value: 0 });
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    return wasmType;
  }

  // Find parent class — if none, super resolves to Object.prototype (most props undefined)
  const parentClassName = ctx.classParentMap.get(currentClassName);
  if (!parentClassName) {
    // In a base class, super.prop resolves to Object.prototype[prop] — usually undefined.
    const accessType = ctx.checker.getTypeAtLocation(expr);
    const wasmType = resolveWasmType(ctx, accessType);
    if (wasmType.kind === "f64") {
      fctx.body.push({ op: "f64.const", value: 0 });
    } else if (wasmType.kind === "i32") {
      fctx.body.push({ op: "i32.const", value: 0 });
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    return wasmType;
  }

  // Check for parent getter accessor — walk up inheritance chain
  let ancestor: string | undefined = parentClassName;
  while (ancestor) {
    const accessorKey = `${ancestor}_${propName}`;
    if (ctx.classAccessorSet.has(accessorKey)) {
      const getterName = `${ancestor}_get_${propName}`;
      const funcIdx = ctx.funcMap.get(getterName);
      if (funcIdx !== undefined) {
        // Push this as argument to the getter.
        // (#3024) NOTE — in a STATIC method there is no `this` local, so nothing
        // is pushed here while the call is emitted regardless, leaving the stack
        // short (`not enough arguments on the stack for call (need 1, got 0)` =
        // invalid Wasm). That is DELIBERATELY not padded here: a static getter
        // is currently compiled instance-shaped (`Base_get_x (param (ref null
        // <Base>))`), so padding the receiver with the type default emits
        // `ref.null; ref.as_non_null`, which TRAPS at runtime — trading invalid
        // Wasm for a guaranteed trap. The sibling `super.<plain static field>`
        // read has the same underlying gap and silently yields `f64.const 0`
        // today. Both need static-super property reads to model the CLASS as the
        // receiver, which is a distinct root cause from the call-arity fix in
        // compileSuperMethodCallCore above. Tracked separately.
        const selfIdx = fctx.localMap.get("this");
        if (selfIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: selfIdx });
        }
        fctx.body.push({ op: "call", funcIdx });
        const propType = ctx.checker.getTypeAtLocation(expr);
        return resolveWasmType(ctx, propType);
      }
    }
    ancestor = ctx.classParentMap.get(ancestor);
  }

  // Fall back to struct field access on `this` — child struct includes parent fields
  // Walk up to find which ancestor defines this field
  ancestor = parentClassName;
  while (ancestor) {
    const structTypeIdx = ctx.structMap.get(ancestor);
    const fields = ctx.structFields.get(ancestor);
    if (structTypeIdx !== undefined && fields) {
      const fieldIdx = fields.findIndex((f) => f.name === propName);
      if (fieldIdx !== -1) {
        // Use the current class's struct since it inherits all parent fields
        const currentStructTypeIdx = ctx.structMap.get(currentClassName);
        const currentFields = ctx.structFields.get(currentClassName);
        if (currentStructTypeIdx !== undefined && currentFields) {
          const currentFieldIdx = currentFields.findIndex((f) => f.name === propName);
          if (currentFieldIdx !== -1) {
            const selfIdx = fctx.localMap.get("this");
            if (selfIdx !== undefined) {
              fctx.body.push({ op: "local.get", index: selfIdx });
            }
            fctx.body.push({
              op: "struct.get",
              typeIdx: currentStructTypeIdx,
              fieldIdx: currentFieldIdx,
            });
            return currentFields[currentFieldIdx]!.type;
          }
        }
        // If not found in current, try parent struct directly
        const selfIdx = fctx.localMap.get("this");
        if (selfIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: selfIdx });
        }
        fctx.body.push({
          op: "struct.get",
          typeIdx: structTypeIdx,
          fieldIdx,
        });
        return fields[fieldIdx]!.type;
      }
    }
    ancestor = ctx.classParentMap.get(ancestor);
  }

  // Fallback: could be a method reference (not a call) — try to find a parent method
  // For now, emit a default based on the TypeScript type at the access site
  const accessType = ctx.checker.getTypeAtLocation(expr);
  const wasmType = resolveWasmType(ctx, accessType);
  if (wasmType.kind === "f64") {
    fctx.body.push({ op: "f64.const", value: 0 });
  } else if (wasmType.kind === "i32") {
    fctx.body.push({ op: "i32.const", value: 0 });
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }
  return wasmType;
}

/**
 * Compile `super[expr]` — access a parent class property via computed key on `this`.
 * Resolves the key at compile time if possible and delegates to compileSuperPropertyAccess logic.
 * For dynamic keys, falls back to default value for the access type.
 */
export function compileSuperElementAccess(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ElementAccessExpression,
): ValType | null {
  const argExpr = expr.argumentExpression;
  // Try to resolve the key to a static string
  let propName: string | undefined;
  if (argExpr) {
    if (ts.isStringLiteral(argExpr)) {
      propName = argExpr.text;
    } else if (ts.isNumericLiteral(argExpr)) {
      propName = String(Number(argExpr.text));
    } else {
      propName = resolveComputedKeyExpression(ctx, argExpr);
    }
  }

  if (propName === undefined) {
    // Dynamic key on super — cannot resolve at compile time
    // Emit default value for the access type
    const accessType = ctx.checker.getTypeAtLocation(expr);
    const wasmType = resolveWasmType(ctx, accessType);
    if (wasmType.kind === "f64") {
      fctx.body.push({ op: "f64.const", value: 0 });
    } else if (wasmType.kind === "i32") {
      fctx.body.push({ op: "i32.const", value: 0 });
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    return wasmType;
  }

  // Determine which class we're in
  const currentClassName = resolveEnclosingClassName(fctx);
  if (!currentClassName) {
    // super in object literal method — emit default value
    const accessType2 = ctx.checker.getTypeAtLocation(expr);
    const wasmType2 = resolveWasmType(ctx, accessType2);
    if (wasmType2.kind === "f64") {
      fctx.body.push({ op: "f64.const", value: 0 });
    } else if (wasmType2.kind === "i32") {
      fctx.body.push({ op: "i32.const", value: 0 });
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    return wasmType2;
  }

  // Find parent class — if none, super resolves to Object.prototype
  const parentClassName = ctx.classParentMap.get(currentClassName);
  if (!parentClassName) {
    const accessType2 = ctx.checker.getTypeAtLocation(expr);
    const wasmType2 = resolveWasmType(ctx, accessType2);
    if (wasmType2.kind === "f64") {
      fctx.body.push({ op: "f64.const", value: 0 });
    } else if (wasmType2.kind === "i32") {
      fctx.body.push({ op: "i32.const", value: 0 });
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    return wasmType2;
  }

  // Check for parent getter accessor — walk up inheritance chain
  let ancestor: string | undefined = parentClassName;
  while (ancestor) {
    const accessorKey = `${ancestor}_${propName}`;
    if (ctx.classAccessorSet.has(accessorKey)) {
      const getterName = `${ancestor}_get_${propName}`;
      const funcIdx = ctx.funcMap.get(getterName);
      if (funcIdx !== undefined) {
        const selfIdx = fctx.localMap.get("this");
        if (selfIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: selfIdx });
        }
        fctx.body.push({ op: "call", funcIdx });
        const propType = ctx.checker.getTypeAtLocation(expr);
        return resolveWasmType(ctx, propType);
      }
    }
    ancestor = ctx.classParentMap.get(ancestor);
  }

  // Fall back to struct field access on `this`
  ancestor = parentClassName;
  while (ancestor) {
    const structTypeIdx = ctx.structMap.get(ancestor);
    const fields = ctx.structFields.get(ancestor);
    if (structTypeIdx !== undefined && fields) {
      const fieldIdx = fields.findIndex((f) => f.name === propName);
      if (fieldIdx !== -1) {
        const currentStructTypeIdx = ctx.structMap.get(currentClassName);
        const currentFields = ctx.structFields.get(currentClassName);
        if (currentStructTypeIdx !== undefined && currentFields) {
          const currentFieldIdx = currentFields.findIndex((f) => f.name === propName);
          if (currentFieldIdx !== -1) {
            const selfIdx = fctx.localMap.get("this");
            if (selfIdx !== undefined) {
              fctx.body.push({ op: "local.get", index: selfIdx });
            }
            fctx.body.push({
              op: "struct.get",
              typeIdx: currentStructTypeIdx,
              fieldIdx: currentFieldIdx,
            });
            return currentFields[currentFieldIdx]!.type;
          }
        }
        const selfIdx = fctx.localMap.get("this");
        if (selfIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: selfIdx });
        }
        fctx.body.push({
          op: "struct.get",
          typeIdx: structTypeIdx,
          fieldIdx,
        });
        return fields[fieldIdx]!.type;
      }
    }
    ancestor = ctx.classParentMap.get(ancestor);
  }

  // Fallback: emit default value based on TypeScript type
  const accessType = ctx.checker.getTypeAtLocation(expr);
  const wasmType = resolveWasmType(ctx, accessType);
  if (wasmType.kind === "f64") {
    fctx.body.push({ op: "f64.const", value: 0 });
  } else if (wasmType.kind === "i32") {
    fctx.body.push({ op: "i32.const", value: 0 });
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }
  return wasmType;
}

/**
 * Infer the element type of an untyped `new Array()` by scanning how the
 * target variable is used. Walks the enclosing function body for element
 * assignments (arr[i] = value) and push calls (arr.push(value)), then
 * returns the TS element type of the first concrete (non-any) value found.
 */
export function inferArrayElementType(ctx: CodegenContext, expr: ts.NewExpression): ts.Type | null {
  // Find the variable name this `new Array()` is assigned to.
  // Pattern: `var x = new Array()` or `var x: T = new Array()`
  const parent = expr.parent;
  let varName: string | null = null;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    varName = parent.name.text;
  } else if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(parent.left)
  ) {
    varName = parent.left.text;
  }
  if (!varName) return null;

  // Walk up to the enclosing function body or source file
  let scope: ts.Node = expr;
  while (
    scope &&
    !ts.isFunctionDeclaration(scope) &&
    !ts.isFunctionExpression(scope) &&
    !ts.isArrowFunction(scope) &&
    !ts.isMethodDeclaration(scope) &&
    !ts.isSourceFile(scope)
  ) {
    scope = scope.parent;
  }
  if (!scope) return null;

  let inferredElemType: ts.Type | null = null;

  function visit(node: ts.Node) {
    if (inferredElemType) return; // already found

    // arr[i] = value
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(node.left) &&
      ts.isIdentifier(node.left.expression) &&
      node.left.expression.text === varName
    ) {
      const valType = ctx.checker.getTypeAtLocation(node.right);
      if (!(valType.flags & ts.TypeFlags.Any)) {
        inferredElemType = valType;
        return;
      }
    }

    // arr.push(value)
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "push" &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === varName &&
      node.arguments.length >= 1
    ) {
      const valType = ctx.checker.getTypeAtLocation(node.arguments[0]!);
      if (!(valType.flags & ts.TypeFlags.Any)) {
        inferredElemType = valType;
        return;
      }
    }

    forEachChild(node, visit);
  }

  visit(scope);
  return inferredElemType;
}

/**
 * Flatten call-site arguments, expanding spread elements on array literals
 * into individual expressions. Returns the flat list of expressions.
 * For spread on non-literal arrays, returns null (cannot flatten at compile time).
 */
function flattenCallArgs(args: readonly ts.Expression[]): ts.Expression[] | null {
  const result: ts.Expression[] = [];
  for (const arg of args) {
    if (ts.isSpreadElement(arg)) {
      if (ts.isArrayLiteralExpression(arg.expression)) {
        // Spread on array literal: inline elements
        for (const el of arg.expression.elements) {
          result.push(el);
        }
      } else {
        // Spread on non-literal — can't flatten at compile time
        return null;
      }
    } else {
      result.push(arg);
    }
  }
  return result;
}

/**
 * (#2660 S3a) True when the result of an approved empty-body `new F()` — which
 * the reconstruct path emits as an externref `$Object` — flows into a slot that
 * accepts externref, so returning externref cannot trap. Two safe shapes:
 *   (a) a function-local `var`/`let`/`const x = new F()` whose ALREADY-ALLOCATED
 *       local is externref. `compileVariableStatement` allocates that local from
 *       the binding's declared type BEFORE compiling the initializer (which is
 *       what calls us), so by the time we run the slot's type is final. Reading
 *       the REAL slot type — rather than re-deriving it from the TS annotation —
 *       is robust against every type-override in variables.ts and is exactly the
 *       value the result is `local.set` into.
 *   (a') a MODULE-scope `var x = new F()` whose ALREADY-ALLOCATED module global
 *       is externref (#4163). `collectDeclarations` registers module globals
 *       (registerModuleGlobal) before any body compiles, so the slot type is
 *       final here for the same reason (a)'s is. This is the dominant test262
 *       shape — top-level `var child = new F()` in a script — which the
 *       function-local-only check missed entirely, leaving the whole ES5
 *       inherited-property family on the dead struct path.
 *   (b) an inline member/element receiver `new F().x` / `new F()[i]` (unwrapping
 *       `( )`/`as`/`!`): an externref receiver routes through the dynamic
 *       `__extern_get` + `$proto` walk — the resolution path we want.
 * Anything else (a struct-typed local or global, a call argument, a return, an
 * assignment target) → false → status-quo struct lowering. The conservative
 * miss costs a row, never the floor.
 */
function fnctorNewResultConsumedAsExternref(
  ctx: CodegenContext,
  fctx: FunctionContext,
  newExpr: ts.NewExpression,
): boolean {
  const declParent = newExpr.parent;
  if (ts.isVariableDeclaration(declParent) && declParent.initializer === newExpr && ts.isIdentifier(declParent.name)) {
    const localIdx = fctx.localMap.get(declParent.name.text);
    if (localIdx === undefined) {
      // (a') module-global binding: accept iff the ALLOCATED global slot is
      // externref (the untyped/`any` representation). A struct-typed or numeric
      // global keeps status quo — returning externref into it would trap.
      const globalIdx = ctx.moduleGlobals.get(declParent.name.text);
      if (globalIdx === undefined) return false;
      return ctx.mod.globals[localGlobalIdx(ctx, globalIdx)]?.type.kind === "externref";
    }
    return getLocalType(fctx, localIdx)?.kind === "externref";
  }
  // Inline: unwrap `( )` / `as` / `!` between the new-expression and its consumer.
  let inner: ts.Expression = newExpr;
  let parent: ts.Node = inner.parent;
  while (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isNonNullExpression(parent)) {
    inner = parent;
    parent = parent.parent;
  }
  if (ts.isPropertyAccessExpression(parent) && parent.expression === inner) return true;
  if (ts.isElementAccessExpression(parent) && parent.expression === inner) return true;
  return false;
}

/**
 * (#2660 S3a) Emit an approved empty-body `new F()` as a native `$Object` whose
 * `$proto` is seeded from F's per-fnctor prototype `$Object` (S2,
 * `ctx.fnctorPrototypeObject[F]`). Reuses the ONE `$Object.$proto` walk: the
 * result is a real `$Object`, so its inherited reads resolve natively via
 * `__extern_get`'s proto walk — no parallel `[[Prototype]]` mechanism, and the
 * identity `Object.getPrototypeOf(new F()) === F.prototype` holds.
 *
 * `__object_create(proto)` (ES §20.1.2.2) allocates the fresh `$Object` AND
 * seeds `$proto = (proto is $Object ? proto : null)` in one call — exactly the
 * construction-time snapshot `new F()` needs (§9.1.13: a later `F.prototype = …`
 * reassignment does NOT retro-change existing instances). In standalone both
 * `__object_create` and the prototype global's lazy `__new_plain_object` are
 * DEFINED functions (ensureObjectRuntime — late-imports.ts), so no host import is
 * added and no funcidx shift is incurred; the closed `$__fnctor_<Name>` struct
 * shape is left entirely untouched (no #1100/#2009 canonicalization re-entry).
 *
 * Leaves the new `$Object` externref on the stack and returns its ValType, or
 * null to decline (caller falls through to the bespoke struct lowering).
 */
function compileFnctorNewAsObject(ctx: CodegenContext, fctx: FunctionContext, fnctorKey: string): ValType | null {
  const createIdx = ensureLateImport(ctx, "__object_create", [{ kind: "externref" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  if (createIdx === undefined) return null;
  // Push F's prototype `$Object` (S2's lazy-init read — mints an empty `$Object`
  // if `F.prototype` was never assigned, so `$proto` is always a real object).
  if (!emitFnctorProtoGet(ctx, fctx, fnctorKey)) return null;
  // __object_create(proto) → fresh $Object with $proto = proto. Re-read the
  // funcMap index after emitFnctorProtoGet (its `__new_plain_object` ensure is a
  // defined-func no-op in standalone, but re-reading is the safe late-import
  // discipline every call site in this file follows).
  const finalCreateIdx = ctx.funcMap.get("__object_create") ?? createIdx;
  fctx.body.push({ op: "call", funcIdx: finalCreateIdx });
  return { kind: "externref" };
}

/**
 * Compile `new FuncDecl(args)` where FuncDecl is a function declaration used
 * as a constructor (e.g. `function Foo() { this.x = 1; }; new Foo()`).
 *
 * Strategy:
 * 1. Analyze the function body for `this.prop = value` assignments to determine struct fields.
 * 2. Create a WasmGC struct type with those fields.
 * 3. Create a constructor function that allocates the struct, binds `this`, runs the body, returns the struct.
 * 4. Cache the struct type and constructor so subsequent `new Foo()` calls reuse them.
 */
/**
 * (#3138) Call-site instance→ctor registration for FUNCTION-SCOPE fnctors.
 *
 * The #1712 registration (`__register_fnctor_instance`, ctor PROLOGUE) reads
 * the ctor closure from a module GLOBAL (`moduleGlobals`/`funcClosureGlobals`)
 * — which does not exist when the fnctor is a function-local binding
 * (`export function test() { var Ctor = function(){}; … new Ctor(); }`, the
 * test262 wrap shape). The prologue (inside the synthesized
 * `__fnctor_<Name>_new`) cannot see the caller's local, so for that case the
 * link is registered at the CALL SITE, where the closure local IS in scope.
 * Without the link, `_fnctorProtoLookup` misses and every INHERITED read off
 * the instance — including ToPropertyDescriptor's prototype-inclusive Get
 * (#2680) when the instance is used as a property DESCRIPTOR — silently drops
 * (the `15.2.3.6-3-129` inherited-attribute family).
 *
 * Emitted with the ctor-call result (`(ref null $__fnctor_<Name>)`) on the
 * stack; restores that exact value/type, so downstream consumers are
 * unaffected:
 *
 *   local.tee $__fnctor_reg_tmp      ;; keep the typed instance
 *   extern.convert_any               ;; instance → externref
 *   local.get $<funcName>            ;; closure value (+ convert if a GC ref)
 *   call $__register_fnctor_instance
 *   local.get $__fnctor_reg_tmp      ;; restore
 *
 * Gates (all must hold; any miss = status quo, no emission):
 *  - host lane only (`!ctx.standalone && !ctx.wasi`) — the sidecar/proto-walk
 *    machinery is JS-host; standalone stays byte-identical;
 *  - the module-global gate MISSED (module-global fnctors keep the prologue
 *    registration — byte-identical for them);
 *  - `fctx.localMap` has a slot for `funcName` holding the closure VALUE
 *    (externref or a GC ref). Ref-cell boxed captures are skipped — the raw
 *    local is the CELL, not the closure, and registering the cell identity
 *    would poison the WeakMap;
 *  - runtime handlers are null-tolerant, so a hoisted `new` before the
 *    assignment registers nothing (status quo) instead of trapping.
 *
 * Late-import discipline: `ensureLateImport` + ONE `flushLateImportShifts`
 * AFTER the ctor call is already emitted, then a FRESH `funcMap` lookup for
 * the register import (the #2608 "one terminal flush, never mid-emission"
 * rule; the flush repairs the just-emitted ctor-call index if the import
 * insertion shifted defined functions).
 */
function emitCallSiteFnctorRegistration(
  ctx: CodegenContext,
  fctx: FunctionContext,
  funcName: string,
  instanceTypeIdx: number,
): void {
  if (ctx.standalone || ctx.wasi) return;
  if (ctx.moduleGlobals.get(funcName) !== undefined || ctx.funcClosureGlobals.get(funcName) !== undefined) {
    return; // module-global fnctor — the ctor-prologue registration (#1712) owns it
  }
  const slot = fctx.localMap.get(funcName);
  if (slot === undefined) return;
  if (fctx.boxedCaptures?.has(funcName)) return; // slot holds a ref CELL, not the closure
  const slotType = getLocalType(fctx, slot);
  if (!slotType) return;
  const isExtern = slotType.kind === "externref" || slotType.kind === "ref_extern";
  const isGcRef =
    slotType.kind === "ref" || slotType.kind === "ref_null" || slotType.kind === "anyref" || slotType.kind === "eqref";
  if (!isExtern && !isGcRef) return; // numeric/funcref slot — not a closure value
  ensureLateImport(ctx, "__register_fnctor_instance", [{ kind: "externref" }, { kind: "externref" }], []);
  flushLateImportShifts(ctx, fctx);
  const regIdx = ctx.funcMap.get("__register_fnctor_instance");
  if (regIdx === undefined) return;
  const tmp = allocLocal(fctx, `__fnctor_reg_tmp_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: instanceTypeIdx,
  });
  fctx.body.push({ op: "local.tee", index: tmp });
  fctx.body.push({ op: "extern.convert_any" });
  fctx.body.push({ op: "local.get", index: slot });
  if (!isExtern) fctx.body.push({ op: "extern.convert_any" });
  fctx.body.push({ op: "call", funcIdx: regIdx });
  fctx.body.push({ op: "local.get", index: tmp });
}

/**
 * (#1712 / #3486) Ctor-PROLOGUE instance→ctor-closure registration for a
 * MODULE-scope fnctor. Sibling of `emitCallSiteFnctorRegistration` above, which
 * covers the function-LOCAL case (#3138).
 *
 * Emitted in the prologue — before the user body compiles — because
 * acorn-style ctors call prototype methods on `this` inside the ctor itself
 * (`this.context = this.initialContext()`); an end-of-ctor registration left
 * those in-ctor dispatches unresolvable. JS-host mode only: standalone/WASI
 * construction stays pure Wasm (the native equivalent rides on the #1888
 * open-object runtime in a later dogfood lap).
 *
 * **(#3486) Why the operand is the identifier's own cached-closure ACCESS, not
 * a pre-existing global.** The original #1712 form required
 * `moduleGlobals`/`funcClosureGlobals` to already hold an entry, and BOTH are
 * populated lazily by an earlier identifier-as-VALUE read of `funcName`. So
 * whether the link got emitted at all depended on COMPILE ORDER — and in the
 * shape test262 actually uses,
 *
 *     function DummyError() {}
 *     var prop = function () { throw new DummyError(); };
 *     assert.throws(DummyError, function () { base[prop()] *= expr(); });
 *
 * the `new DummyError()` compiles BEFORE the `DummyError` argument does, so no
 * global existed, the gate missed, and — because the synthesized ctor is built
 * exactly once and cached in `funcConstructorMap` — the link was PERMANENTLY
 * absent. Instances then had no `.constructor` back-pointer at all.
 *
 * `emitCachedFuncClosureAccess` is the same helper identifiers.ts uses for a
 * bare `DummyError` mention, with the same `constructible` flag (unconditionally
 * false in the host lane — see `isOrdinaryFunctionDecl`'s `noJsHost` gate), so
 * the registered value is reference-identical to the one every later mention
 * yields. It fixes both failure modes at once: the singleton is created on
 * demand (no compile-order dependency) AND the lazy cache is evaluated here, so
 * the registered value is never the `null` the global holds before its own
 * first value read.
 *
 * Buffer-reach note: the flush below walks `ctx.currentFunc` (still the OUTER
 * call-site fctx at this point) plus `ctorFctx.body` explicitly; once the body
 * compile switches `ctx.currentFunc` to `ctorFctx`, later shifts reach these
 * prologue instrs through `currentFunc.body`, and after attachment through
 * `ctx.mod.functions`.
 */
function emitCtorPrologueFnctorRegistration(
  ctx: CodegenContext,
  ctorFctx: FunctionContext,
  constructorIdentityParamIdx: number,
  selfLocal: number,
): void {
  if (ctx.standalone || ctx.wasi) return;
  ensureLateImport(ctx, "__register_fnctor_instance", [{ kind: "externref" }, { kind: "externref" }], []);
  flushLateImportShifts(ctx, ctorFctx);
  const regIdx = ctx.funcMap.get("__register_fnctor_instance");
  if (regIdx === undefined) return;
  ctorFctx.body.push({ op: "local.get", index: selfLocal });
  ctorFctx.body.push({ op: "extern.convert_any" });
  // The caller evaluated the real constructor value before its arguments and
  // passed that exact closure identity. A synthesized cached closure is not
  // equivalent for capturing nested constructors: prototype writes land on
  // the live closure while the cache owns a different, empty sidecar.
  ctorFctx.body.push({ op: "local.get", index: constructorIdentityParamIdx });
  ctorFctx.body.push({ op: "call", funcIdx: regIdx });
}

function compileNewFunctionDeclaration(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.NewExpression,
  funcName: string,
  funcDecl: ts.FunctionDeclaration,
): ValType | null {
  const body = funcDecl.body;
  if (!body) return null;
  const fnctorKey = resolveFnctorSymbol(ctx.checker, expr.expression)?.name ?? funcName;

  // (#2660 S3a) Reconstruct an APPROVED, EMPTY-BODY `new F()` as a native
  // `$Object` (standalone) so its inherited-prototype reads route through the
  // ONE `$Object.$proto` walk instead of the bespoke `$__fnctor_<Name>` struct,
  // which has no `$proto` field and misses every inherited read. Verified on
  // current main: `function Con(){}; Con.prototype={foo:7}; const c:any=new
  // Con(); c.foo` returns 0 on the struct path; reconstruction makes it 7.
  //
  // This is the value-rep CANARY (the low-risk first slice). It fires ONLY on a
  // proven-safe intersection and keeps the status-quo struct lowering everywhere
  // else, so it cannot regress a typed own-field read (#1888 floor). The broad
  // binding-retype that banks the test262 cluster is S3b — intentionally NOT
  // here. The gate (ALL must hold; any miss → fall through to the struct):
  //   (G0) standalone — host/WASI keep the existing lowering BYTE-IDENTICAL
  //        (host has the #1712 instance→prototype sidecar; `__object_create` is
  //        native only in standalone via ensureObjectRuntime — late-imports.ts).
  //   (G1) the S1 escape-gate approved THIS exact site (node identity) — i.e.
  //        dynamically consumed AND no typed own-field consumer (clause A∧B).
  //   (G2) truly empty body — no `this.x=` (so no own field exists to regress)
  //        AND no ctor-body side effects to drop (running the body is S3c).
  //   (G3) no constructor args — nothing to evaluate/drop (arg'd sites keep
  //        status quo, which still runs their arg side effects via the ctor).
  //   (G4) the instance's result-externref flows into an externref slot: a
  //        function-local binding whose ALLOCATED local is externref (the
  //        `any`/`unknown` case), OR an inline `new F().x` / `new F()[i]`
  //        receiver. Reading the REAL local type (not the TS annotation) is the
  //        load-bearing safety check — returning externref into a struct-ref
  //        local would `ref.cast`-trap (that retype ripple is S3b).
  //   (G5) the one proven live `F.prototype` value is not an Array carrier
  //        (#4387). `__object_create` can seed only its `$Object` `$proto`
  //        slot, so reconstructing an Array-valued prototype discards the
  //        chain. Keep that exact shape on the raw fnctor representation,
  //        whose shared closed-method runtime recognizes the live Array.
  //
  // Cache-order note: this gate sits at the cache-MISS entry. If a NON-approved
  // sibling `new F()` of the same fnctor compiled first, it populated
  // `funcConstructorMap[F]` and a later approved site hits that cache in
  // `compileNewExpression` (returning the struct) WITHOUT reaching this gate — so
  // it keeps status quo. That is a safe MISS (a 0-row outcome), never a trap: the
  // struct ref coerces cleanly into the approved site's externref/any binding.
  // S3b's binding-retype removes the miss; S3a deliberately does not chase it.
  if (
    ctx.standalone &&
    ctx.fnctorEscapeGate?.approved.has(expr) &&
    !ctx.fnctorEscapeGate.stableArrayPrototypeNames.has(fnctorKey) &&
    body.statements.length === 0 &&
    (expr.arguments?.length ?? 0) === 0 &&
    fnctorNewResultConsumedAsExternref(ctx, fctx, expr)
  ) {
    const reconstructed = compileFnctorNewAsObject(ctx, fctx, fnctorKey);
    if (reconstructed) return reconstructed;
    // Helper declined (e.g. `__object_create` unavailable) → fall through to the
    // bespoke struct lowering below (status quo, safe).
  }

  // 1. Derive the fnctor's field shape from the ctor body's `this.<field> = …`
  // writes. (#2773 S1) The derivation is the SHARED single source of truth
  // `deriveFnctorFields` (fnctor-escape-gate.ts) — extracted verbatim from the
  // logic that used to live inline here — so the up-front reservation pass and
  // this on-demand path produce the SAME field set/order. Empty constructors yield
  // `[]` → a minimal struct (the `var Con = function(){}; new Con()` prototype
  // test262 pattern). The chained-assignment + if/loop recursion and the
  // `ref → ref_null` widening (so `struct.new` can default a ref field) live
  // INSIDE the shared helper.
  const structName = `__fnctor_${funcName}`;

  // 2. Reserve-or-register the struct type. (#2773 S1) When the escape gate
  // approved this fnctor, its `$__fnctor_<Name>` slot was reserved UP-FRONT at the
  // deterministic type-init phase (reserveFnctorStructTypes, index.ts) — its index
  // is pass-invariant, and `structMap` / `typeIdxToStructName` / `structFields` are
  // already populated with the SAME field shape. Trust the reserved index and pull
  // the reserved `fields` for the struct.new init loop below — do NOT push a new
  // type (that would re-shift every downstream typeIdx and re-introduce the
  // hoist-vs-emit desync this slice exists to kill). Otherwise (a fnctor the gate
  // didn't approve) keep the legacy on-demand registration as a defensive fallback.
  let structTypeIdx = ctx.fnctorReservedTypeIdx.get(funcName);
  let fields: FieldDef[];
  if (structTypeIdx !== undefined) {
    // Reserved up-front — copy the reserved field set (same FieldDef objects, same
    // order) so the struct.new field-init loop matches the reserved type's arity.
    fields = [...ctx.structFields.get(structName)!];
  } else {
    fields = deriveFnctorFields(ctx, funcDecl);
    structTypeIdx = ctx.mod.types.length;
    ctx.mod.types.push({
      kind: "struct",
      name: structName,
      fields,
    });
    ctx.structMap.set(structName, structTypeIdx);
    ctx.typeIdxToStructName.set(structTypeIdx, structName);
    ctx.structFields.set(structName, fields);
  }

  // 3. Build the constructor function
  // Constructor params match the function declaration params
  const userCtorParams: ValType[] = [];
  for (let i = 0; i < funcDecl.parameters.length; i++) {
    const param = funcDecl.parameters[i]!;
    const paramType = ctx.checker.getTypeAtLocation(param);
    userCtorParams.push(resolveWasmType(ctx, paramType));
  }
  // (fnctor-ctor-arguments.ts) Asked ONCE and shared by both halves of the
  // `arguments` protocol — the ctor-body materialization below and the call
  // site's `__extras_argv` publication — so they cannot disagree about whether
  // the protocol is live for this constructor.
  const ctorReadsArguments = fnctorCtorNeedsArguments(funcDecl);
  const captureLayout = fnctorCaptureLayout(ctx, funcName);
  const ctorIdentityParamIdx = captureLayout.allParamTypes.length + userCtorParams.length;
  const ctorParams = fnctorConstructorParams(ctx, userCtorParams, captureLayout.allParamTypes);

  const ctorName = `${structName}_new`;
  // (#2071, revisits the #4464 "deliberately not widened" decision) When the
  // body can `return` a FOREIGN object, the ctor result is widened to
  // externref and §10.2.1.3 step 13 is resolved at runtime by the same
  // `emitConstructReturnSelect` probe the `new function(){…}` lowering uses
  // (`constructThisExternLocal` regime in statements/control-flow.ts).
  //
  // #4464's blocker — "a property read on the `new` site's value is typed
  // from the CHECKER's constructor-instance type" — was re-probed on current
  // main before this widening: the DYNAMIC member path now resolves BOTH a
  // struct-backed fnctor-instance prop AND a plain-`$Object` prop correctly
  // (laundered-read probes, 2/2 pass), so an externref-flowing result reads
  // right for the normal instance and the override alike. A site whose
  // binding is statically struct-typed coerces the externref back with a
  // guarded cast: unchanged for genuine instances, and a foreign override
  // reaching such a site was spec-divergent under the old ABI too.
  //
  // Predicate-gated (body must actually carry a possibly-foreign `return`)
  // and standalone/WASI-gated, so every other ctor keeps the historical
  // `(ref $Struct)` ABI byte-identically — including the host lane, whose
  // #1712 call-site registration tees the result into a struct-typed temp.
  const resultIsExtern = (ctx.standalone || ctx.wasi) && fnctorBodyMayReturnForeignObject(funcDecl);
  const ctorResults: ValType[] = resultIsExtern ? [{ kind: "externref" }] : [{ kind: "ref", typeIdx: structTypeIdx }];
  const ctorTypeIdx = addFuncType(ctx, ctorParams, ctorResults, `${ctorName}_type`);
  const ctorFuncIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(classMemberFuncKey(ctx, ctorName), ctorFuncIdx); // (#1983) collision-free key

  const ctorFunc = {
    name: ctorName,
    typeIdx: ctorTypeIdx,
    locals: [] as { name: string; type: ValType }[],
    body: [] as Instr[],
    exported: false,
  };
  pushDefinedFunc(ctx, ctorFuncIdx, ctorFunc);

  // Cache the mapping
  ctx.funcConstructorMap.set(funcName, {
    structTypeIdx,
    ctorFuncName: ctorName,
    captureLayout,
    resultIsExtern,
    readsArguments: ctorReadsArguments,
  });

  // 4. Compile the constructor body
  const paramDefs: { name: string; type: ValType }[] = [];
  for (let i = 0; i < captureLayout.captures.length; i++) {
    const capture = captureLayout.captures[i]!;
    paramDefs.push({ name: capture.name, type: captureLayout.valueParamTypes[i]! });
  }
  for (const capture of captureLayout.captures) {
    if (capture.hasTdzFlag) {
      const flagIndex =
        captureLayout.captures.slice(0, captureLayout.captures.indexOf(capture) + 1).filter((entry) => entry.hasTdzFlag)
          .length - 1;
      paramDefs.push({ name: `__tdz_box_${capture.name}`, type: captureLayout.tdzFlagParamTypes[flagIndex]! });
    }
  }
  // (fnctor-ctor-arguments.ts) Where this ctor's FIRST user-declared parameter
  // sits, past the capture / TDZ-flag parameters — the `paramOffset` the
  // `arguments` vec indexes from.
  const userParamOffset = paramDefs.length;
  for (let i = 0; i < funcDecl.parameters.length; i++) {
    const p = funcDecl.parameters[i]!;
    paramDefs.push({
      name: ts.isIdentifier(p.name) ? p.name.text : `__param${i}`,
      type: userCtorParams[i] ?? { kind: "f64" },
    });
  }
  appendFnctorConstructorParam(ctx, paramDefs);

  const ctorFctx: FunctionContext = {
    name: ctorName,
    params: paramDefs,
    locals: [],
    localMap: new Map(),
    returnType: ctorResults[0]!,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
    // (#4464) This IS a [[Construct]] body: §10.2.1.3 step 13 governs its
    // `return`s (Object overrides `this`; anything else is discarded and the
    // result is `this`). Without the bit a `return <primitive>` compiled
    // through the generic value path, which coerced the operand to the struct
    // return type — i.e. pushed `ref.null $__fnctor_<F>` — and the `new` site
    // trapped on the first property read. See `isFnctorConstructor`.
    isFnctorConstructor: true,
    // The JS-host constructor executes with a concrete fnctor receiver, which
    // lets constructor-time prototype calls use the in-Wasm driver before
    // exports are available. Standalone keeps the historical dynamic `this`
    // representation: forcing the struct fact there bypasses prototype
    // overrides used by generic String methods on custom constructors.
    ...(!ctx.standalone && !ctx.wasi ? { thisStructName: structName } : {}),
  };
  // The synthesized fnctor body is still the source function's activation for
  // legacy Function#caller. Register it before any prologue/body emission so
  // outgoing calls carry the constructor source's strictness.
  initializeFunctionPoisonPillContext(ctx, ctorFctx, funcDecl);

  // Set up param locals
  installFrameTrap(ctorFctx, ctorName);
  for (let i = 0; i < ctorFctx.params.length; i++) {
    ctorFctx.localMap.set(ctorFctx.params[i]!.name, i);
  }
  registerFnctorCaptureParams(ctx, ctorFctx, captureLayout);

  // (#3927 per-type layouts) A split family allocates the layout the caller
  // hinted (via the per-family hint global), defaulting to the full-union
  // sibling on hint 0 — the ctor reads and RESETS the hint, so a stale hint is
  // consumed at most once and every failure direction degrades to "fat, never
  // narrow". Non-split fnctors keep the single-struct path byte-identically.
  const layoutInfo = ctx.fnctorLayoutInfo?.get(structName);
  if (layoutInfo !== undefined) {
    emitLayoutSelectingStructNew(ctx, ctorFctx, layoutInfo, ctorIdentityParamIdx);
  } else {
    emitFnctorFieldInitializers(ctx, ctorFctx, fields, ctorIdentityParamIdx);
    ctorFctx.body.push({ op: "struct.new", typeIdx: structTypeIdx });
  }

  // Store in __self local
  const selfLocal = allocLocal(ctorFctx, "__self", {
    kind: "ref",
    typeIdx: structTypeIdx,
  });
  ctorFctx.body.push({ op: "local.set", index: selfLocal });

  // Bind `this` to the struct
  ctorFctx.localMap.set("this", selfLocal);

  // (#2071) Widened regime: mirror the receiver into an externref local and
  // hand it to the `constructThisExternLocal` return arm, which compiles every
  // `return` operand as externref and runs the §10.2.1.3 step-13 runtime
  // select (`emitConstructReturnSelect`) — Object/function operands override,
  // everything else yields the receiver. The mirror is set BEFORE the user
  // body compiles so the first `return` already sees it.
  let selfExternLocal: number | undefined;
  if (resultIsExtern) {
    selfExternLocal = allocLocal(ctorFctx, "__self_extern", { kind: "externref" });
    ctorFctx.body.push(
      { op: "local.get", index: selfLocal },
      { op: "extern.convert_any" },
      { op: "local.set", index: selfExternLocal },
    );
    ctorFctx.constructThisExternLocal = selfExternLocal;
  }

  // (#1712) Register the instance → constructor-closure link with the JS
  // host so instance property misses resolve through the closure's vivified
  // `.prototype` object (acorn's `Parser.prototype.m = fn; new Parser().m()`
  // pattern). Emitted in the ctor PROLOGUE — before the user body compiles —
  // because acorn-style ctors call prototype methods on `this` inside the
  // ctor itself (`this.context = this.initialContext()`); an end-of-ctor
  // registration left those in-ctor dispatches unresolvable. JS-host mode
  // only — standalone/WASI construction stays pure Wasm; the native
  // equivalent rides on the #1888 open-object runtime in a later dogfood lap.
  // Buffer-reach note: the flush below walks ctx.currentFunc (still the
  // OUTER call-site fctx here) plus ctorFctx.body explicitly; once the body
  // compile switches ctx.currentFunc to ctorFctx, later shifts reach these
  // prologue instrs through currentFunc.body, and after attachment through
  // ctx.mod.functions.
  emitCtorPrologueFnctorRegistration(ctx, ctorFctx, ctorIdentityParamIdx, selfLocal);

  // Compile the function body
  const savedFunc = ctx.currentFunc;
  if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
  if (savedFunc) ctx.funcStack.push(savedFunc);
  ctx.currentFunc = ctorFctx;
  // (#4139) A function-EXPRESSION constructor compiled as a closure carries
  // the transitive captures of every sibling it calls as struct fields; the
  // standalone identity param holds that closure value. Spill the fields into
  // frame locals named after the captures BEFORE the body compiles, so
  // sibling-call prepends and direct reads resolve in-frame instead of
  // addressing the declaring frame's dead slots.
  if (ctx.standalone) {
    const closureRecord = ctx.closureStructByNode?.get(funcDecl);
    if (closureRecord) {
      materializeFnctorTwinCaptures(ctx, ctorFctx, closureRecord.structTypeIdx, ctorIdentityParamIdx);
    }
  }
  // (fnctor-ctor-arguments.ts) Materialize `arguments` — the one prologue step
  // this synthesized body was missing relative to `function-body.ts`, which is
  // why `arguments` read back as `null` inside every `new F(…)`. Emitted here,
  // with `ctx.currentFunc === ctorFctx`, so a late-import shift reaches these
  // instructions through `currentFunc.body` like any other body instruction.
  if (ctorReadsArguments) {
    emitFnctorCtorArgumentsObject(ctx, ctorFctx, funcDecl, userParamOffset, userCtorParams);
  }
  // (#2071) Hoist the constructor body's own function declarations BEFORE its
  // statements compile — the same prologue every other function body gets
  // (`function-body.ts`). Without it a ctor that calls a function declared
  // later in its own body
  //
  //     function FACTORY(){ this.id = func(); function func(){ return "s"; } }
  //
  // compiled the call while `func` was still unregistered, so it fell through
  // to the `ref.null.extern` fallback and the field read back `null`/`NaN`
  // instead of the returned value (test262 `S13.2.2_A12`). The name scope is
  // opened and closed around the body for the #4456 reason: the hoisted names
  // are lexically this constructor's, and a later same-named declaration
  // elsewhere must not alias this one's compiled function.
  const ctorNameScope = beginNestedFunctionNameScope(ctx);
  try {
    hoistFunctionDeclarations(ctx, ctorFctx, body.statements);
    for (const stmt of body.statements) {
      compileStatement(ctx, ctorFctx, stmt);
    }
  } finally {
    endNestedFunctionNameScope(ctx, ctorNameScope);
  }
  if (savedFunc) ctx.funcStack.pop();
  if (savedFunc) ctx.parentBodiesStack.pop();
  ctx.currentFunc = savedFunc;

  // Attach the live body array to the registered function FIRST: the
  // late-import registration below can shift function indices, and the shift
  // walkers reach this body only through ctx.mod.functions (#1712 — same
  // orphan-buffer class as the compileIfStatement then-branch fix).
  ctorFunc.locals = ctorFctx.locals;
  ctorFunc.body = ctorFctx.body;

  // (#1712) The instance → constructor-closure registration
  // (__register_fnctor_instance) is emitted in the ctor PROLOGUE above —
  // before the user body — so in-ctor prototype-method calls on `this`
  // (`this.context = this.initialContext()`) already resolve through the
  // vivified prototype.

  // Return the constructed receiver (as externref when the body's `return`s
  // widened the result — #4464/#2071: the implicit fall-off-the-end result is
  // always the receiver; only explicit `return <object>` overrides).
  if (selfExternLocal !== undefined) {
    ctorFctx.body.push({ op: "local.get", index: selfExternLocal });
  } else {
    ctorFctx.body.push({ op: "local.get", index: selfLocal });
  }

  // 5. Emit the call to the constructor at the call site
  const args = expr.arguments ?? [];
  // Use the in-scope ctorParams, NOT getFuncParamTypes(ctx, ctorFuncIdx): the
  // (#1712) __register_fnctor_instance late import above opens a deferred
  // index-shift window (#329/#1899) in which ctorFuncIdx is stale-low against
  // the already-incremented numImportFuncs, so an index-based signature lookup
  // would read the PREVIOUS function's params and coerce arguments against the
  // wrong types (observed: `call[0] expected externref, found (ref null $N)`).
  const paramTypes: ValType[] | undefined = userCtorParams;
  emitFnctorConstructorArguments(ctx, fctx, captureLayout, expr.expression, args, paramTypes, ctorReadsArguments);
  // Re-lookup funcIdx in case addUnionImports shifted indices
  const finalCtorIdx = ctx.funcMap.get(classMemberFuncKey(ctx, ctorName)) ?? ctorFuncIdx; // (#1983)
  // (fnctor-ctor-arguments.ts) `maybeSetArgcForKnownCall` keys on
  // `ctx.funcUsesArguments`, which holds the SOURCE name — never the synthesized
  // `__fnctor_<F>_new` passed here — so it returns early for every constructor.
  // When the ctor reads `arguments`, `emitFnctorConstructorArguments` has
  // already set `__argc` alongside `__extras_argv`; leave it alone.
  if (!ctorReadsArguments) {
    maybeSetArgcForKnownCall(ctx, fctx, ctorName, args.length, paramTypes?.length ?? args.length);
  }
  fctx.body.push({ op: "call", funcIdx: finalCtorIdx });
  // (#3138) Function-scope fnctor: link instance → ctor closure at the call
  // site (the ctor prologue can't — no module global to read). No-op for
  // module-global fnctors / standalone / non-closure slots — and the widened
  // (#2071) regime is standalone-only, so the struct-typed tee inside the
  // registration never meets an externref result.
  emitCallSiteFnctorRegistration(ctx, fctx, funcName, structTypeIdx);
  return resultIsExtern ? { kind: "externref" } : { kind: "ref", typeIdx: structTypeIdx };
}

/**
 * Compile `new FunctionExpression(args)` — treats the function expression
 * as an immediately-invoked constructor. The function body is compiled
 * as a lifted closure function and called with the provided arguments.
 * Supports spread arguments and the `arguments` object.
 */
function compileNewFunctionExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.NewExpression,
  funcExpr: ts.FunctionExpression,
): ValType | null {
  const closureId = ctx.closureCounter++;
  const closureName = `__new_ctor_${closureId}`;
  const body = funcExpr.body;
  if (!body || !ts.isBlock(body)) return null;

  // 1. Flatten call-site arguments (resolve spread on array literals)
  const rawArgs = expr.arguments ?? [];
  const flatArgs = flattenCallArgs(rawArgs);
  if (!flatArgs) {
    // Can't flatten spread at compile time — unsupported
    reportError(ctx, expr, "new FunctionExpression with non-literal spread not supported");
    return null;
  }

  const needsArguments = needsImplicitArgumentsObject(funcExpr);

  // (#4464) §10.2.1.3 steps 1-5: `new <FunctionExpression>(…)` creates an
  // ordinary object, calls the body with it as `this`, and yields it (unless
  // the body returns an Object of its own). This lowering used to do none of
  // that — it called the body and then pushed a literal `ref.null.extern` with
  // the comment "we don't construct actual objects" — so `new function
  // __func(){this.prop=1}` evaluated to null and the very next property read
  // trapped (`S13.2.2_A16_T1/T2/T3`).
  //
  // The receiver is a native `$Object` minted at the call site and threaded in
  // as a TRAILING parameter. Trailing, not leading, is load-bearing: the
  // `arguments` materialization below indexes the formal parameters from a
  // fixed `paramOffset` of 1 (just past the closure struct), so prepending
  // would have silently shifted every mapped-argument slot.
  //
  // Reserve the import BEFORE any instruction of this construction is emitted:
  // a late import shifts defined-function indices, and the flush can only
  // patch instructions it can reach. Declining here (no object runtime) keeps
  // the historical null result rather than emitting a half-built construction.
  const newPlainObjectIdx = ensureLateImport(ctx, "__new_plain_object", [], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  const constructsReceiver = newPlainObjectIdx !== undefined;

  // 2. Determine the parameter list for the lifted function
  //    Use the function's formal params if it has them, otherwise
  //    create f64 params matching the flattened call-site args.
  const formalParams: ValType[] = [];
  if (funcExpr.parameters.length > 0) {
    for (const p of funcExpr.parameters) {
      const paramType = ctx.checker.getTypeAtLocation(p);
      formalParams.push(resolveWasmType(ctx, paramType));
    }
  } else {
    // No formal params — create f64 params for each call-site arg
    for (let i = 0; i < flatArgs.length; i++) {
      formalParams.push({ kind: "f64" });
    }
  }

  // 3. Analyze captured variables
  const referencedNames = new Set<string>();
  for (const stmt of body.statements) {
    collectReferencedIdentifiers(stmt, referencedNames);
  }
  const writtenInClosure = new Set<string>();
  for (const stmt of body.statements) {
    collectWrittenIdentifiers(stmt, writtenInClosure);
  }

  const captures: {
    name: string;
    type: ValType;
    localIdx: number;
    mutable: boolean;
    alreadyBoxed: boolean;
    valType?: ValType;
  }[] = [];
  for (const name of referencedNames) {
    const localIdx = fctx.localMap.get(name);
    if (localIdx === undefined) continue;
    if (ctx.funcMap.has(name)) continue;
    // #1832 — `isOwnParamName` recognises names bound by a destructuring
    // (object/array binding) parameter, not just identifier params. The old
    // identifier-only check missed `function({a}){ return a }`, so a
    // destructured param name was wrongly treated as a free variable and
    // captured from an outer scope that also declared it.
    if (isOwnParamName(funcExpr, name)) continue;
    if (name === "arguments") continue;
    const type =
      localIdx < fctx.params.length
        ? fctx.params[localIdx]!.type
        : (fctx.locals[localIdx - fctx.params.length]?.type ?? { kind: "f64" });
    const isMutable = writtenInClosure.has(name);
    const alreadyBoxed = !!fctx.boxedCaptures?.has(name);
    const valType = alreadyBoxed ? fctx.boxedCaptures!.get(name)!.valType : undefined;
    captures.push({
      name,
      type,
      localIdx,
      mutable: isMutable,
      alreadyBoxed,
      valType,
    });
  }

  // 4. Build the closure struct type
  const structFields = [
    { name: "func", type: { kind: "funcref" as const }, mutable: false },
    ...captures.map((c) => {
      if (c.mutable) {
        if (c.alreadyBoxed) {
          // Local already holds a ref cell — reuse the existing ref-cell type
          // (the local's type IS the ref cell type). Avoids double-wrapping
          // when the variable was pre-boxed at function entry (#996).
          return { name: c.name, type: c.type, mutable: false };
        }
        const refCellTypeIdx = getOrRegisterRefCellType(ctx, c.type);
        return {
          name: c.name,
          type: { kind: "ref_null" as const, typeIdx: refCellTypeIdx },
          mutable: false,
        };
      }
      return { name: c.name, type: c.type, mutable: false };
    }),
  ];

  const structTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: `${closureName}_struct`,
    fields: structFields,
  });

  // 5. Build the lifted function
  //    Params: (ref $closure_struct, arg0: f64, arg1: f64, ...)
  const liftedParams: ValType[] = [{ kind: "ref", typeIdx: structTypeIdx }, ...formalParams];
  if (constructsReceiver) liftedParams.push({ kind: "externref" }); // (#4464) the `this` receiver

  const liftedFuncTypeIdx = addFuncType(
    ctx,
    liftedParams,
    constructsReceiver ? [{ kind: "externref" }] : [],
    `${closureName}_type`,
  );

  // Create the lifted function context
  const paramDefs: { name: string; type: ValType }[] = [
    { name: "__self", type: { kind: "ref", typeIdx: structTypeIdx } },
  ];
  if (funcExpr.parameters.length > 0) {
    for (let i = 0; i < funcExpr.parameters.length; i++) {
      const p = funcExpr.parameters[i]!;
      paramDefs.push({
        name: ts.isIdentifier(p.name) ? p.name.text : `__param${i}`,
        type: formalParams[i] ?? { kind: "f64" },
      });
    }
  } else {
    for (let i = 0; i < flatArgs.length; i++) {
      paramDefs.push({ name: `__arg${i}`, type: { kind: "f64" } });
    }
  }
  // (#4464) Named `this` so the ordinary `this.<prop> = …` lowering resolves it
  // out of `localMap` exactly as a class constructor's receiver does.
  const receiverParamIdx = paramDefs.length;
  if (constructsReceiver) paramDefs.push({ name: "this", type: { kind: "externref" } });

  const liftedFctx: FunctionContext = {
    name: closureName,
    params: paramDefs,
    locals: [],
    localMap: new Map(),
    returnType: constructsReceiver ? { kind: "externref" } : null,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
    ...(constructsReceiver ? { constructThisExternLocal: receiverParamIdx } : {}),
  };
  // `new (function () { ... })` lowers to a synthetic lifted function, but its
  // body keeps the function expression's source strictness.
  initializeFunctionPoisonPillContext(ctx, liftedFctx, funcExpr);

  for (let i = 0; i < liftedFctx.params.length; i++) {
    liftedFctx.localMap.set(liftedFctx.params[i]!.name, i);
  }

  // Initialize locals for captured variables from struct fields
  for (let i = 0; i < captures.length; i++) {
    const cap = captures[i]!;
    if (cap.mutable) {
      // If the outer scope already had this variable boxed (pre-box from #996
      // or a previous closure that boxed it), the struct field IS the ref cell
      // — extract the existing ref-cell type index and reuse the original
      // value type so the inner code reads/writes through the SAME cell as
      // the outer scope.
      let refCellTypeIdx: number;
      let valType: ValType;
      if (cap.alreadyBoxed && (cap.type.kind === "ref" || cap.type.kind === "ref_null")) {
        refCellTypeIdx = (cap.type as { typeIdx: number }).typeIdx;
        valType = cap.valType ?? { kind: "f64" };
      } else {
        refCellTypeIdx = getOrRegisterRefCellType(ctx, cap.type);
        valType = cap.type;
      }
      const refCellType: ValType = {
        kind: "ref_null",
        typeIdx: refCellTypeIdx,
      };
      const localIdx = allocLocal(liftedFctx, cap.name, refCellType);
      liftedFctx.body.push({ op: "local.get", index: 0 });
      liftedFctx.body.push({
        op: "struct.get",
        typeIdx: structTypeIdx,
        fieldIdx: i + 1,
      });
      liftedFctx.body.push({ op: "local.set", index: localIdx });
      if (!liftedFctx.boxedCaptures) liftedFctx.boxedCaptures = new Map();
      liftedFctx.boxedCaptures.set(cap.name, {
        refCellTypeIdx,
        valType,
      });
    } else {
      // Check if this capture is an already-boxed ref cell from the outer scope
      const outerBoxed = fctx.boxedCaptures?.get(cap.name);
      if (outerBoxed && (cap.type.kind === "ref" || cap.type.kind === "ref_null")) {
        const refCellType: ValType = {
          kind: "ref_null",
          typeIdx: outerBoxed.refCellTypeIdx,
        };
        const localIdx = allocLocal(liftedFctx, cap.name, refCellType);
        liftedFctx.body.push({ op: "local.get", index: 0 });
        liftedFctx.body.push({
          op: "struct.get",
          typeIdx: structTypeIdx,
          fieldIdx: i + 1,
        });
        liftedFctx.body.push({ op: "local.set", index: localIdx });
        if (!liftedFctx.boxedCaptures) liftedFctx.boxedCaptures = new Map();
        liftedFctx.boxedCaptures.set(cap.name, {
          refCellTypeIdx: outerBoxed.refCellTypeIdx,
          valType: outerBoxed.valType,
        });
      } else {
        const localIdx = allocLocal(liftedFctx, cap.name, cap.type);
        liftedFctx.body.push({ op: "local.get", index: 0 });
        liftedFctx.body.push({
          op: "struct.get",
          typeIdx: structTypeIdx,
          fieldIdx: i + 1,
        });
        liftedFctx.body.push({ op: "local.set", index: localIdx });
      }
    }
  }

  // Set up `arguments` if the body references it
  if (needsArguments) {
    // Ensure __box_number is available for boxing numeric params
    const hasNumericFormal = formalParams.some((pt) => pt.kind === "f64" || pt.kind === "i32");
    if (hasNumericFormal) {
      ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);
    }

    const numArgs = formalParams.length;
    const elemType: ValType = { kind: "externref" };
    const vti = getOrRegisterVecType(ctx, "externref", elemType);
    const ati = getArrTypeIdxFromVec(ctx, vti);
    const vecRef: ValType = { kind: "ref", typeIdx: vti };
    const argsLocal = allocLocal(liftedFctx, "arguments", vecRef);
    const arrTmp = allocLocal(liftedFctx, "__args_arr_tmp", {
      kind: "ref",
      typeIdx: ati,
    });

    // Ensure __unbox_number is available for reverse sync
    if (hasNumericFormal) {
      ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
      flushLateImportShifts(ctx, liftedFctx);
    }

    // Set up mapped arguments info (#849) — params start at index 1 (skip __self)
    liftedFctx.mappedArgsInfo = {
      argsLocalIdx: argsLocal,
      arrTypeIdx: ati,
      vecTypeIdx: vti,
      paramCount: numArgs,
      paramOffset: 1, // skip __self capture param
      paramTypes: formalParams.slice(),
    };

    // Push each param coerced to externref
    for (let i = 0; i < numArgs; i++) {
      liftedFctx.body.push({ op: "local.get", index: i + 1 }); // skip __self
      const pt = formalParams[i]!;
      if (pt.kind === "f64") {
        const boxIdx = ctx.funcMap.get("__box_number");
        if (boxIdx !== undefined) {
          liftedFctx.body.push({ op: "call", funcIdx: boxIdx });
        } else {
          liftedFctx.body.push({ op: "drop" });
          liftedFctx.body.push({ op: "ref.null.extern" });
        }
      } else if (pt.kind === "i32") {
        liftedFctx.body.push({ op: "f64.convert_i32_s" });
        const boxIdx = ctx.funcMap.get("__box_number");
        if (boxIdx !== undefined) {
          liftedFctx.body.push({ op: "call", funcIdx: boxIdx });
        } else {
          liftedFctx.body.push({ op: "drop" });
          liftedFctx.body.push({ op: "ref.null.extern" });
        }
      } else if (pt.kind === "ref" || pt.kind === "ref_null") {
        liftedFctx.body.push({ op: "extern.convert_any" });
      }
      // externref params are already externref — no conversion needed
    }
    liftedFctx.body.push({
      op: "array.new_fixed",
      typeIdx: ati,
      length: numArgs,
    });
    liftedFctx.body.push({ op: "local.set", index: arrTmp });
    liftedFctx.body.push({ op: "i32.const", value: numArgs });
    liftedFctx.body.push({ op: "local.get", index: arrTmp });
    liftedFctx.body.push({ op: "struct.new", typeIdx: vti });
    liftedFctx.body.push({ op: "local.set", index: argsLocal });
  }

  // 6. Compile the function body
  const savedFunc = ctx.currentFunc;
  if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
  if (savedFunc) ctx.funcStack.push(savedFunc);
  ctx.currentFunc = liftedFctx;
  for (const stmt of body.statements) {
    compileStatement(ctx, liftedFctx, stmt);
  }
  // (#4464) Fall-through completion of a [[Construct]] body yields the
  // receiver (§10.2.1.3 step 13's `undefined` branch), and it doubles as the
  // function's required result value.
  if (constructsReceiver) {
    liftedFctx.body.push({ op: "local.get", index: receiverParamIdx });
  }
  if (savedFunc) ctx.funcStack.pop();
  if (savedFunc) ctx.parentBodiesStack.pop();
  ctx.currentFunc = savedFunc;

  // 7. Register the lifted function
  const liftedFuncIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, liftedFuncIdx, {
    name: closureName,
    typeIdx: liftedFuncTypeIdx,
    locals: liftedFctx.locals,
    body: liftedFctx.body,
    exported: false,
  });
  ctx.funcMap.set(closureName, liftedFuncIdx);

  // 8. At the call site: build closure struct, push args, call
  fctx.body.push({ op: "ref.func", funcIdx: liftedFuncIdx });
  for (const cap of captures) {
    if (cap.mutable) {
      if (fctx.boxedCaptures?.has(cap.name)) {
        fctx.body.push({ op: "local.get", index: cap.localIdx });
      } else {
        const refCellTypeIdx = getOrRegisterRefCellType(ctx, cap.type);
        fctx.body.push({ op: "local.get", index: cap.localIdx });
        fctx.body.push({ op: "struct.new", typeIdx: refCellTypeIdx });
        const boxedLocalIdx = allocLocal(fctx, `__boxed_${cap.name}`, {
          kind: "ref_null",
          typeIdx: refCellTypeIdx,
        });
        fctx.body.push({ op: "local.tee", index: boxedLocalIdx });
        fctx.localMap.set(cap.name, boxedLocalIdx);
        if (!fctx.boxedCaptures) fctx.boxedCaptures = new Map();
        fctx.boxedCaptures.set(cap.name, { refCellTypeIdx, valType: cap.type });
      }
    } else {
      fctx.body.push({ op: "local.get", index: cap.localIdx });
    }
  }
  fctx.body.push({ op: "struct.new", typeIdx: structTypeIdx });

  // Store closure struct in local for __self arg
  const closureLocal = allocLocal(fctx, `__ctor_closure_${closureId}`, {
    kind: "ref",
    typeIdx: structTypeIdx,
  });
  fctx.body.push({ op: "local.set", index: closureLocal });

  // (#4464) Mint the construction receiver BEFORE the arguments so the
  // `$Object` exists no matter what the argument expressions do, and park it in
  // a local — it is the LAST call operand and the value the site yields.
  let receiverLocal: number | undefined;
  if (constructsReceiver) {
    const resolvedNewObjIdx = ctx.funcMap.get("__new_plain_object") ?? newPlainObjectIdx!;
    fctx.body.push({ op: "call", funcIdx: resolvedNewObjIdx });
    receiverLocal = allocLocal(fctx, `__ctor_this_${closureId}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: receiverLocal });
  }

  // Push __self argument
  fctx.body.push({ op: "local.get", index: closureLocal });

  // Push call-site arguments (flattened, spread already resolved).
  // (#4464) Arity is now enforced here: a surplus argument is evaluated (source
  // order, side effects intact) and dropped, a missing one gets its parameter's
  // default. Previously both cases pushed the wrong number of operands, which
  // with the trailing receiver operand would be a module-validation error
  // rather than a silently shifted parameter.
  for (let i = 0; i < flatArgs.length; i++) {
    const actual = compileExpression(ctx, fctx, flatArgs[i]!, formalParams[i]);
    if (i >= formalParams.length && actual !== null && actual !== undefined) {
      fctx.body.push({ op: "drop" });
    }
  }
  for (let i = flatArgs.length; i < formalParams.length; i++) {
    pushDefaultValue(fctx, formalParams[i]!, ctx);
  }
  if (receiverLocal !== undefined) {
    fctx.body.push({ op: "local.get", index: receiverLocal });
  }

  // Call the lifted function. Re-resolve its index from funcMap: compiling the
  // arguments above may have added late imports (e.g. an object-spread arg like
  // `{...null}` pulls in `__new_plain_object`/`__object_assign`), which shifts
  // every defined-function index up. The shift machinery patches funcMap and the
  // already-emitted `ref.func` instruction, but the `liftedFuncIdx` captured at
  // registration time is stale — using it here would make `call` and `ref.func`
  // disagree, emitting an invalid module (#1602).
  const resolvedLiftedIdx = ctx.funcMap.get(closureName) ?? liftedFuncIdx;
  fctx.body.push({ op: "call", funcIdx: resolvedLiftedIdx });

  // (#4464) The lifted body now RETURNS the construction result (its receiver,
  // or an Object the body returned instead), so the call already leaves it on
  // the stack. Only the declined path — no object runtime in this module — has
  // a void call and still needs the historical null placeholder.
  if (!constructsReceiver) {
    fctx.body.push({ op: "ref.null.extern" });
  }
  return { kind: "externref" };
}

/**
 * Compile a ClassExpression used as a value (e.g. `x = class { ... }`).
 * The class should already be collected during the collection phase.
 * We produce the constructor function reference so the class can be instantiated.
 */
/**
 * §15.7.1 ClassDefinitionEvaluation: a named class binds its own name in an
 * inner scope that is populated only AFTER the `extends` clause is evaluated.
 * Referencing that name inside `extends` hits the TDZ — `(class x extends x {})`
 * must throw ReferenceError (#1594B). The inner binding shadows any outer `x`,
 * so any reference to the class's own name in `extends` is the TDZ binding.
 */
function classExtendsReferencesOwnName(expr: ts.ClassExpression): boolean {
  if (!expr.name) return false;
  const ownName = expr.name.text;
  if (!expr.heritageClauses) return false;
  for (const clause of expr.heritageClauses) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    for (const typeNode of clause.types) {
      let found = false;
      const visit = (node: ts.Node): void => {
        if (found) return;
        if (ts.isIdentifier(node) && node.text === ownName) {
          found = true;
          return;
        }
        ts.forEachChild(node, visit);
      };
      visit(typeNode.expression);
      if (found) return true;
    }
  }
  return false;
}

/**
 * (#1602) Emit a class-expression-as-value: the constructor wrapped in a
 * closure-struct converted to externref. A bare `ref.func` (funcref) is NOT a
 * subtype of anyref/externref, so when the class value flowed into an externref
 * context — `(class {...}).f` member read feeding `__extern_get`, or passed as
 * a call argument — the raw funcref was left on the stack where externref was
 * required, producing an invalid module (`call expected externref, found
 * ref.func`). Mirror the proven `ClassName.constructor` / static-method
 * extraction path: wrap the ctor funcref in a closure struct and
 * `extern.convert_any`. Falls back to the legacy funcref only if closure
 * construction fails (signature unresolvable), preserving prior behaviour.
 */
function emitClassCtorValue(ctx: CodegenContext, fctx: FunctionContext, ctorName: string, funcIdx: number): ValType {
  const closureRef = emitFuncRefAsClosure(ctx, fctx, ctorName, funcIdx);
  if (closureRef) {
    fctx.body.push({ op: "extern.convert_any" });
    return { kind: "externref" };
  }
  fctx.body.push({ op: "ref.func", funcIdx });
  return { kind: "funcref" };
}

function compileClassExpression(ctx: CodegenContext, fctx: FunctionContext, expr: ts.ClassExpression): ValType | null {
  // §15.7.1: the class-expression name is in TDZ during its own `extends`
  // evaluation. `(class x extends x {})` must throw ReferenceError (#1594B).
  if (classExtendsReferencesOwnName(expr)) {
    emitThrowReferenceError(ctx, fctx, `Cannot access '${expr.name!.text}' before initialization`);
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  // Look up the synthetic name assigned during the collection phase
  const syntheticName = ctx.anonClassExprNames.get(expr);
  const classNameForCheck = syntheticName ?? expr.name?.text;

  // ES2015 14.5.14 step 21: class with static 'prototype' member must throw TypeError
  if (classNameForCheck && ctx.classThrowsOnEval.has(classNameForCheck)) {
    emitThrowTypeError(ctx, fctx, "Classes may not have a static property named 'prototype'");
    fctx.body.push({ op: "unreachable" });
    return { kind: "externref" };
  }

  if (syntheticName) {
    const ctorName = `${syntheticName}_new`;
    const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, ctorName)); // (#1983)
    if (funcIdx !== undefined) {
      return emitClassCtorValue(ctx, fctx, ctorName, funcIdx);
    }
  }

  // If the class has a name, check if it was collected under that name
  if (expr.name) {
    const className = expr.name.text;
    if (ctx.classSet.has(className)) {
      const ctorName = `${className}_new`;
      const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, ctorName)); // (#1983)
      if (funcIdx !== undefined) {
        return emitClassCtorValue(ctx, fctx, ctorName, funcIdx);
      }
    }
  }

  // Fallback: produce externref null (class was not collected)
  fctx.body.push({ op: "ref.null.extern" });
  return { kind: "externref" };
}

/**
 * (#2026) Result ValType of a Wasm function by index — mirrors
 * `getFuncParamTypes` but reads `results[0]`. The dynamic-new fallback uses it
 * to decide whether a `<Class>_new` result needs `extern.convert_any` boxing
 * (anyref / struct-ref result) or is ALREADY an externref — in which case a
 * second `extern.convert_any` emits invalid Wasm (`extern.convert_any[0]
 * expected anyref, found externref`). Returns `undefined` for void / unknown.
 */
function getFuncResultType(ctx: CodegenContext, funcIdx: number): ValType | undefined {
  // #1916 S2 — funcSignatureOf is the positional-read chokepoint (func-space.ts).
  const sig = funcSignatureOf(ctx, funcIdx);
  return sig && sig.results.length > 0 ? sig.results[0] : undefined;
}

/**
 * (#3981) Standalone/WASI ordinary [[Construct]] for a first-class function
 * VALUE — the host lane's `__construct_closure` bridge, lowered natively.
 *
 * Before this, a value-bound constructor matched no compiled class tag, every
 * `ref.test` in the dynamic-`new` dispatch chain declined, and the arm fell
 * through to `ref.null.extern`: `new C()` was silently **null**, with no trap
 * and no diagnostic. That is the `cookie` package's `standalone · runtime
 * dynamic` failure — `parseCookie` returns `new NullObject()` where
 * `NullObject` is an IIFE-returned function expression, so every caller got
 * null and the first property read threw "Cannot access property on null or
 * undefined".
 *
 * Placement matters: this runs AFTER the class and function-declaration
 * (fnctor) arms, so a compiled class or a `function F(){}` / `var F =
 * function(){}` constructor keeps its existing typed-struct lowering
 * byte-for-byte. Only a callee those arms declined reaches here.
 *
 * Returns `undefined` to decline (caller continues its normal dispatch).
 */
function resolvesToNativeProxyValue(ctx: CodegenContext, expression: ts.Expression): boolean {
  const seen = new Set<ts.Symbol>();
  const unwrap = (value: ts.Expression): ts.Expression => {
    let current = value;
    while (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isTypeAssertionExpression(current)
    ) {
      current = current.expression;
    }
    return current;
  };
  const isProxyFactory = (value: ts.Expression): boolean => {
    const current = unwrap(value);
    if (ts.isNewExpression(current) && ts.isIdentifier(current.expression) && current.expression.text === "Proxy") {
      return true;
    }
    if (
      ts.isPropertyAccessExpression(current) &&
      current.name.text === "proxy" &&
      ts.isCallExpression(unwrap(current.expression))
    ) {
      const call = unwrap(current.expression) as ts.CallExpression;
      return (
        ts.isPropertyAccessExpression(call.expression) &&
        ts.isIdentifier(call.expression.expression) &&
        call.expression.expression.text === "Proxy" &&
        call.expression.name.text === "revocable"
      );
    }
    if (!ts.isIdentifier(current)) return false;
    const symbol = ctx.checker.getSymbolAtLocation(current);
    if (!symbol || seen.has(symbol)) return false;
    seen.add(symbol);
    const declaration = symbol.valueDeclaration;
    return declaration !== undefined && ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined
      ? isProxyFactory(declaration.initializer)
      : false;
  };
  return isProxyFactory(expression);
}

function tryCompileNativeConstructFromValue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  calleeExpr: ts.Expression,
  rawArgs: readonly ts.Expression[],
): ValType | undefined {
  if (!noJsHost(ctx) && ctx.targetProfile.semanticProviders !== "native-first") return undefined;
  if (!ts.isIdentifier(calleeExpr)) return undefined;
  // A compiled fnctor for this binding means the typed-struct path owns it.
  if (ctx.funcConstructorMap.has(calleeExpr.text)) return undefined;
  const runtimeFunctionAlias =
    ctx.runtimeEvalCallableBoundaryEnabled === true && resolvesToGlobalFunctionAlias(calleeExpr, ctx.oracle);
  const proxyValue = resolvesToNativeProxyValue(ctx, calleeExpr);
  if (!runtimeFunctionAlias && !proxyValue && !resolvesToConstructableFunctionValue(ctx, calleeExpr)) return undefined;

  // A linked `%Function%` alias is a provider marker rather than a local
  // closure struct. Reserve the argv builders + generic apply bridge used by
  // the construct driver's exact marker arm; ordinary function values retain
  // the existing method-dispatch lowering.
  if (runtimeFunctionAlias || proxyValue) {
    if (proxyValue) ensureNativeProxyRuntime(ctx);
    ensureObjVecBuilders(ctx);
    reserveApplyClosure(ctx);
  }

  // A non-flattenable spread has a RUNTIME argument count, so no fixed-arity
  // driver fits; decline rather than construct with the wrong argument list.
  const args = flattenCallArgs(rawArgs) ?? rawArgs;
  if (args.some((a) => ts.isSpreadElement(a))) return undefined;
  if (args.length > MAX_NATIVE_CONSTRUCT_ARITY) return undefined;

  // Register the object-model helpers the driver body calls and flush ONCE,
  // before any emission — the driver bakes `call <funcIdx>` values that a later
  // import insertion would otherwise shift (#608/#794).
  ensureLateImport(ctx, "__extern_get", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
  ensureLateImport(ctx, "__object_create", [{ kind: "externref" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  addStringConstantGlobal(ctx, "prototype");
  const driverIdx = reserveNativeConstructDriver(ctx, args.length, stringConstantExternrefInstrs(ctx, "prototype"));

  // Evaluate the callee, then each argument, exactly once and in source order.
  const calleeTy = compileExpression(ctx, fctx, calleeExpr, { kind: "externref" });
  if (calleeTy && calleeTy.kind !== "externref") {
    coerceType(ctx, fctx, calleeTy, { kind: "externref" });
  } else if (calleeTy === null) {
    fctx.body.push({ op: "ref.null.extern" });
  }
  const calleeLocal = allocLocal(fctx, `__nc_callee_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: calleeLocal });

  // The prototype. A `F.prototype = …` write that #2660 S2 recognised lives in
  // the per-fnctor module global, NOT on the closure — so read it from there
  // when the binding resolves, and let the driver fall back to
  // `__extern_get(callee, "prototype")` otherwise. Without this the instance is
  // created with a null `$proto` and every inherited read returns undefined.
  const fnctorName = resolveUserFnctorName(ctx, calleeExpr);
  if (fnctorName === undefined || !emitFnctorProtoGet(ctx, fctx, fnctorName)) {
    fctx.body.push({ op: "ref.null.extern" });
  }
  const protoLocal = allocLocal(fctx, `__nc_proto_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: protoLocal });

  const argLocals: number[] = [];
  for (const arg of args) {
    const argTy = compileExpression(ctx, fctx, arg, { kind: "externref" });
    if (argTy && argTy.kind !== "externref") {
      coerceType(ctx, fctx, argTy, { kind: "externref" });
    } else if (argTy === null) {
      fctx.body.push({ op: "ref.null.extern" });
    }
    const argLocal = allocLocal(fctx, `__nc_arg${argLocals.length}_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: argLocal });
    argLocals.push(argLocal);
  }

  fctx.body.push({ op: "local.get", index: calleeLocal });
  fctx.body.push({ op: "local.get", index: protoLocal });
  for (const argLocal of argLocals) fctx.body.push({ op: "local.get", index: argLocal });
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get(`__native_construct_${args.length}`) ?? driverIdx });
  return { kind: "externref" };
}

/**
 * (#2026) Dynamic-new fallback: `new K(...)` where `K` is a value-bound
 * identifier (a class flowing through a parameter / variable of type `any`)
 * that the static resolution arms could not pin to a known class. The value in
 * `K` is the `__class_<Name>` class-object singleton — an `extern.convert_any`'d
 * `$ClassName` struct (the SAME struct type as instances of that class). We
 * dispatch by a `ref.test $ClassName` type-test chain over every WasmGC-struct
 * class with a class-object descriptor (`ctx.classObjectGlobals`): on the first
 * matching struct type, call its `<Class>_new` with the (pre-evaluated, boxed)
 * arguments coerced to each ctor param's ValType, then box the instance to
 * externref. Returns `true` when the fallback emitted code (caller returns
 * `{ kind: "externref" }`), `false` when no candidate classes exist (caller
 * keeps the legacy `__new_` host-import path so genuine host builtins such as
 * `Test262Error` still work).
 *
 * Pure-Wasm (no host import): works in standalone / WASI. The static
 * `new C()` path (the `classSet` arm) is untouched — only this value-bound
 * fallback is new, so there is no perf or shape change for statically-resolved
 * construction.
 */
function emitDynamicNewFallback(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.NewExpression,
  calleeExpr: ts.Expression,
  ctorName: string,
): boolean {
  // Candidate classes: those with a class-object descriptor singleton and a
  // WasmGC struct (externref-backed builtin subclasses are excluded — they have
  // no `$ClassName` struct and no `<Class>_new` returning a ref).
  const candidates: string[] = [];
  for (const className of ctx.classObjectGlobals.keys()) {
    if (ctx.classBuiltinParentMap.has(className)) continue;
    if (ctx.structMap.get(className) === undefined) continue;
    const ctorIdx = ctx.funcMap.get(classMemberFuncKey(ctx, `${className}_new`));
    if (ctorIdx === undefined) continue;
    // The tag-dispatch reads the descriptor as a `$ClassName` struct (ref.test /
    // struct.get 0) and boxes the instance to externref. That only holds when
    // `<Class>_new` actually returns the WasmGC struct ref. A ctor whose result
    // is already externref is externref-backed (no `$ClassName` struct to
    // type-test against), so it can be neither tag-discriminated nor struct-read
    // here — exclude it so it falls through to the legacy host-import path
    // instead of emitting an invalid `ref.test`/double-`extern.convert_any` (the
    // #2026 ~20-test regression: a value-bound TypedArray ctor `new TA()`).
    const ctorResult = getFuncResultType(ctx, ctorIdx);
    if (ctorResult?.kind === "externref") continue;
    candidates.push(className);
  }
  if (candidates.length === 0) return false;

  const rawArgs = expr.arguments ?? [];

  // (#2026 PR-3a) Spread arguments. A `SpreadElement` compiles to the array/
  // iterator value (an i32 length / ref), not a boxed externref, so reaching the
  // per-arg eval loop verbatim makes the downstream `extern.convert_any` emit
  // INVALID Wasm (whole-module instantiate failure). Flatten an array-LITERAL
  // spread (`new K(...[a, b])`) into its element expressions via the shared
  // `flattenCallArgs` helper — the same compile-time flatten the static
  // class-`new` path uses.
  //
  // (#2026 #53) A non-flattenable spread (`new K(...someVar)`) has a RUNTIME
  // length, so there is no compile-time-fixed arg count. We can't use fixed
  // `argLocals`; instead we build a runtime `$ObjVecArr` argv (+ `argc`) below
  // and each tag-arm reads `argv[i]` with a runtime bounds check. This supersedes
  // the earlier loud-refuse (PR-3a, #1699): variable spread now WORKS rather than
  // failing to compile.
  let args: readonly ts.Expression[] = rawArgs;
  const hasSpread = rawArgs.some((a) => ts.isSpreadElement(a));
  let useRuntimeArgv = false;
  if (hasSpread) {
    const flat = flattenCallArgs(rawArgs);
    if (flat !== null) {
      args = flat; // all spreads were array literals — flatten at compile time
    } else {
      useRuntimeArgv = true; // a non-literal spread is present — runtime argv
    }
  }

  // (#53) The runtime-argv path needs the `$ObjVecArr` `(array (mut externref))`
  // type. It is RESERVED up-front for class-bearing sources (`reserveObjVecArrType`
  // in the type-init phase) precisely so a body can reference a STABLE index —
  // minting it lazily here baked an unresolved `-1` heap-type ref at binary-emit
  // (#2043 / reference_subview_type_idx_stability). If the reservation is somehow
  // absent (defensive — every class-bearing source reserves it), bail loudly
  // rather than emit a broken module.
  if (useRuntimeArgv && ctx.reservedObjVecArrTypeIdx === undefined) {
    reportError(
      ctx,
      expr,
      "Dynamic `new K(...x)` runtime-argv needs the up-front-reserved $ObjVecArr type (#2026 #53), " +
        "which was not reserved for this module.",
    );
    fctx.body.push({ op: "ref.null.extern" });
    return true;
  }

  // Runtime argv may need externref→vec coercion, whose reader path registers
  // several helpers. Do that as one batch BEFORE evaluating the callee or any
  // argument. Registering them lazily while visiting a later spread shifts
  // defined-function indices, which can leave an earlier positional call (for
  // example `mark(1)`) targeting the wrong function. The checker can represent
  // `any` with an internal ref type even though expression codegen produces an
  // externref, so gate on the runtime-argv shape itself rather than trying to
  // predict the expression representation. Static and literal-spread `new`
  // remain unchanged.
  if (useRuntimeArgv) {
    ensureLateImport(ctx, "__extern_length", [{ kind: "externref" }], [{ kind: "f64" }]);
    ensureLateImport(ctx, "__extern_get", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
    ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
    ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
    if (noJsHost(ctx)) {
      ensureLateImport(ctx, "__extern_get_idx", [{ kind: "externref" }, { kind: "f64" }], [{ kind: "externref" }]);
    } else {
      ensureLateImport(ctx, "__array_from_iter", [{ kind: "externref" }], [{ kind: "externref" }]);
    }
    flushLateImportShifts(ctx, fctx);
  }

  // (#3087) When the value-bound ctor is an `any`/`unknown`-typed dynamic value
  // (most importantly a callback PARAMETER receiving a real constructor — the
  // TypedArray harness `function (TA) { new TA(buffer, 0, 4) }`), a genuine host
  // constructor value matches NONE of the compiled-class tags and hits the
  // no-match base below. On the JS-host lane, route that base through the
  // `__construct_closure` bridge (its runtime side runs the spec IsConstructor
  // probe + `Reflect.construct`) instead of the non-existent `__new_${ctorName}`
  // extern-class import — the dominant #3074 downstream honest-fail
  // ("No dependency provided for extern class 'TA'"). Ensure the bridge imports
  // up-front and flush ONCE here so the funcIdx is stable before any body
  // emission (the #608/#794 late-import index-shift hazard). Scoped to the
  // Runtime argv is supported too: its no-match arm copies the materialized
  // argv into the bridge's JS array without re-evaluating any source expression.
  const useConstructClosureBase = !noJsHost(ctx) && resolvesToDynamicAnyCtorValue(ctx, calleeExpr);
  let ccArrNewIdx: number | undefined = -1;
  let ccArrPushIdx: number | undefined = -1;
  let ccBridgeIdx: number | undefined = -1;
  if (useConstructClosureBase) {
    ccArrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
    ccArrPushIdx = ensureLateImport(ctx, "__js_array_push", [{ kind: "externref" }, { kind: "externref" }], []);
    ccBridgeIdx = ensureLateImport(
      ctx,
      "__construct_closure",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
  }

  // Evaluate the callee descriptor once into an anyref local (the value to
  // type-test). null/undefined descriptors leave a null anyref → every
  // `ref.test` is false → falls through to the trailing no-match arm.
  const calleeTy = compileExpression(ctx, fctx, calleeExpr, { kind: "externref" });
  if (calleeTy && calleeTy.kind !== "externref") {
    coerceType(ctx, fctx, calleeTy, { kind: "externref" });
  } else if (calleeTy === null) {
    fctx.body.push({ op: "ref.null.extern" });
  }
  fctx.body.push({ op: "any.convert_extern" });
  const descLocal = allocLocal(fctx, `__dynnew_desc_${fctx.locals.length}`, { kind: "anyref" } as ValType);
  fctx.body.push({ op: "local.set", index: descLocal });

  // ── Argument materialization ───────────────────────────────────────────────
  // Two shapes feed the per-class tag-arms:
  //  - `argLocals` (fixed-arity, the common case): one boxed externref temp per
  //    positional arg; arm `i` reads `argLocals[i]` (compile-time bounds).
  //  - runtime argv (`useRuntimeArgv`, a non-literal spread present): a single
  //    `$ObjVecArr` (`(array (mut externref))`) holding ALL args in source order
  //    plus an `argc` i32; arm `i` reads `argv[i]` with a runtime bounds check.
  const argLocals: number[] = [];
  let argvLocal = -1;
  let argcLocal = -1;
  let objVecArrTypeIdx = -1;
  // Emit `local <idx> = local <idx> + 1` (i32 cursor bump).
  const bumpI32Local = (f: FunctionContext, idx: number): void => {
    f.body.push({ op: "local.get", index: idx });
    f.body.push({ op: "i32.const", value: 1 });
    f.body.push({ op: "i32.add" });
    f.body.push({ op: "local.set", index: idx });
  };
  if (!useRuntimeArgv) {
    // Pre-evaluate each argument once into an externref temp (boxed). Each
    // dispatch arm reads these and coerces to the matched ctor's param ValType,
    // so argument expressions run exactly once regardless of which class matches.
    for (let i = 0; i < args.length; i++) {
      const aTy = compileExpression(ctx, fctx, args[i]!, { kind: "externref" });
      if (aTy && aTy.kind !== "externref") {
        coerceType(ctx, fctx, aTy, { kind: "externref" });
      } else if (aTy === null) {
        fctx.body.push({ op: "ref.null.extern" });
      }
      const aLocal = allocLocal(fctx, `__dynnew_arg${i}_${fctx.locals.length}`, { kind: "externref" });
      fctx.body.push({ op: "local.set", index: aLocal });
      argLocals.push(aLocal);
    }
  } else {
    // (#53) Build a runtime argv. Reserve a generously-sized `$ObjVecArr` and an
    // `argc` cursor, then append each arg in source order: a plain positional
    // arg is boxed and written at argv[argc++]; a spread's source is compiled to
    // its vec struct {len, data} and each element copied (boxed) into argv.
    objVecArrTypeIdx = ctx.reservedObjVecArrTypeIdx!;
    argvLocal = allocLocal(fctx, `__dynnew_argv_${fctx.locals.length}`, { kind: "ref", typeIdx: objVecArrTypeIdx });
    argcLocal = allocLocal(fctx, `__dynnew_argc_${fctx.locals.length}`, { kind: "i32" });

    // Pass 1 — evaluate EVERY argument exactly once, in source order, and retain
    // either its boxed value or its normalized vec. The old two-pass shape only
    // evaluated spread sources here and deferred positional expressions until
    // pass 2, so `new K(mark(1), ...markArray(2), mark(3))` observed 2,1,3.
    //
    // A JS/untyped helper parameter (the Test262 temporalHelpers.js shape) has
    // static type `externref` even when its runtime value is a boxed Wasm vec.
    // Normalize that carrier through the established externref→canonical-vec
    // coercion before reading `{length,data}`. In standalone/WASI this uses the
    // native `__extern_length` / `__extern_get_idx` readers, so it introduces no
    // `env` imports and preserves the original element values as externrefs.
    type MaterializedRuntimeArg =
      | { kind: "value"; local: number }
      | { kind: "spread"; local: number; vecTypeIdx: number; arrTypeIdx: number; elemType: ValType };
    const materializedArgs: MaterializedRuntimeArg[] = [];
    const capacityLocal = allocLocal(fctx, `__dynnew_capacity_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "local.set", index: capacityLocal });
    for (const arg of rawArgs) {
      if (!ts.isSpreadElement(arg)) {
        const aTy = compileExpression(ctx, fctx, arg, { kind: "externref" });
        if (aTy && aTy.kind !== "externref") coerceType(ctx, fctx, aTy, { kind: "externref" });
        else if (aTy === null) fctx.body.push({ op: "ref.null.extern" });
        const valueLocal = allocLocal(fctx, `__dynnew_value_${fctx.locals.length}`, { kind: "externref" });
        fctx.body.push({ op: "local.set", index: valueLocal });
        materializedArgs.push({ kind: "value", local: valueLocal });
        bumpI32Local(fctx, capacityLocal);
        continue;
      }

      let vecTy = compileExpression(ctx, fctx, arg.expression);
      if (vecTy?.kind === "externref") {
        const canonicalVecTypeIdx = getOrRegisterVecType(ctx, "externref", { kind: "externref" });
        const canonicalVecTy: ValType = { kind: "ref_null", typeIdx: canonicalVecTypeIdx };
        coerceType(ctx, fctx, vecTy, canonicalVecTy);
        vecTy = canonicalVecTy;
      }
      if (!vecTy || (vecTy.kind !== "ref" && vecTy.kind !== "ref_null")) {
        // Spread source is not an array-like vec (e.g. a non-iterable). Bail
        // loudly rather than emit a wrong value. (Full iterator-protocol drive
        // over arbitrary iterables is #42.) Keep the stack balanced: the caller
        // returns externref on `true`.
        if (vecTy) fctx.body.push({ op: "drop" });
        reportError(
          ctx,
          expr,
          "Dynamic `new K(...x)` spread source is not an array-like value (#2026 #53): " +
            "only array spreads are supported in the value-bound constructor path.",
        );
        fctx.body.push({ op: "ref.null.extern" });
        return true;
      }
      const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTy.typeIdx);
      if (arrTypeIdx < 0) {
        fctx.body.push({ op: "drop" });
        reportError(
          ctx,
          expr,
          "Dynamic `new K(...x)` spread source is not an array-like value (#2026 #53): " +
            "only array spreads are supported in the value-bound constructor path.",
        );
        fctx.body.push({ op: "ref.null.extern" });
        return true;
      }
      const vecLocal = allocLocal(fctx, `__dynnew_svec_${fctx.locals.length}`, vecTy);
      fctx.body.push({ op: "local.set", index: vecLocal });
      // capacity += vec.length (vec struct field 0)
      fctx.body.push({ op: "local.get", index: capacityLocal });
      fctx.body.push({ op: "local.get", index: vecLocal });
      fctx.body.push({ op: "struct.get", typeIdx: vecTy.typeIdx, fieldIdx: 0 });
      fctx.body.push({ op: "i32.add" });
      fctx.body.push({ op: "local.set", index: capacityLocal });
      const arrDef = arrTypeIdx >= 0 ? ctx.mod.types[arrTypeIdx] : undefined;
      const elemType: ValType = arrDef && arrDef.kind === "array" ? arrDef.element : { kind: "f64" };
      materializedArgs.push({ kind: "spread", local: vecLocal, vecTypeIdx: vecTy.typeIdx, arrTypeIdx, elemType });
    }
    fctx.body.push({ op: "local.get", index: capacityLocal });
    fctx.body.push({ op: "array.new_default", typeIdx: objVecArrTypeIdx });
    fctx.body.push({ op: "local.set", index: argvLocal });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "local.set", index: argcLocal });

    // Pass 2 — append the retained values/vec elements in source order. No
    // source expression is re-evaluated in this pass.
    for (const materialized of materializedArgs) {
      if (materialized.kind === "value") {
        // argv[argc++] = retained boxed positional value
        fctx.body.push({ op: "local.get", index: argvLocal });
        fctx.body.push({ op: "local.get", index: argcLocal });
        fctx.body.push({ op: "local.get", index: materialized.local });
        fctx.body.push({ op: "array.set", typeIdx: objVecArrTypeIdx });
        bumpI32Local(fctx, argcLocal);
        continue;
      }
      const sv = materialized;
      // len = svec.len ; data = svec.data ; j = 0
      const jLocal = allocLocal(fctx, `__dynnew_j_${fctx.locals.length}`, { kind: "i32" });
      const lenLocal = allocLocal(fctx, `__dynnew_slen_${fctx.locals.length}`, { kind: "i32" });
      const dataLocal = allocLocal(fctx, `__dynnew_sdata_${fctx.locals.length}`, {
        kind: "ref_null",
        typeIdx: sv.arrTypeIdx,
      });
      fctx.body.push({ op: "local.get", index: sv.local });
      fctx.body.push({ op: "struct.get", typeIdx: sv.vecTypeIdx, fieldIdx: 0 });
      fctx.body.push({ op: "local.set", index: lenLocal });
      fctx.body.push({ op: "local.get", index: sv.local });
      fctx.body.push({ op: "struct.get", typeIdx: sv.vecTypeIdx, fieldIdx: 1 });
      fctx.body.push({ op: "local.set", index: dataLocal });
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "local.set", index: jLocal });

      // Build the loop body: argv[argc] = box(data[j]); argc++; j++.
      const loopBody: Instr[] = [];
      const savedBody = fctx.body;
      fctx.body = loopBody;
      // j >= len ? break (br_if depth 1 → out of the enclosing block).
      fctx.body.push({ op: "local.get", index: jLocal });
      fctx.body.push({ op: "local.get", index: lenLocal });
      fctx.body.push({ op: "i32.ge_s" });
      fctx.body.push({ op: "br_if", depth: 1 }); // break outer block
      // argv[argc] = box(data[j])
      fctx.body.push({ op: "local.get", index: argvLocal });
      fctx.body.push({ op: "local.get", index: argcLocal });
      fctx.body.push({ op: "local.get", index: dataLocal });
      fctx.body.push({ op: "local.get", index: jLocal });
      emitBoundsCheckedArrayGet(fctx, sv.arrTypeIdx, sv.elemType);
      if (sv.elemType.kind !== "externref") coerceType(ctx, fctx, sv.elemType, { kind: "externref" });
      fctx.body.push({ op: "array.set", typeIdx: objVecArrTypeIdx });
      // argc++ ; j++
      bumpI32Local(fctx, argcLocal);
      bumpI32Local(fctx, jLocal);
      fctx.body.push({ op: "br", depth: 0 }); // loop back
      fctx.body = savedBody;

      // (block (loop <loopBody>)) — loopBody breaks via `br_if 1`, repeats via `br 0`.
      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
      });
    }
  }

  // Discriminate by the class TAG, never by struct type alone. WasmGC
  // iso-recursive canonicalization merges structurally-identical class structs
  // (two classes `{ x: number }` collapse to one runtime `(struct (__tag i32)
  // (x f64))` type even though they keep distinct `structMap` indices), so
  // `ref.test $A` is ALSO true for a `$B` descriptor of the same shape (#2009).
  // The `__tag` field (index 0) carries the unique class id.
  //
  // Strategy: (1) read the descriptor's `__tag` ONCE — a `ref.test`/`ref.cast`
  // against any one candidate struct type yields a layout that exposes field 0
  // for every shape-compatible class (canonicalization guarantees the read is
  // valid whenever the test passes); we OR together a test per distinct struct
  // shape so descriptors of any candidate shape get their tag read. (2) Dispatch
  // on the tag value with a single flat chain over ALL candidates, independent
  // of struct grouping — this is what makes shape-colliding classes correct.
  const distinctStructIdxs = [...new Set(candidates.map((c) => ctx.structMap.get(c)!))];
  const tagLocal = allocLocal(fctx, `__dynnew_tag_${fctx.locals.length}`, { kind: "i32" });

  // (1) Read the tag. Default -1 (no match) so a non-class / null descriptor
  // selects no ctor and yields null. For each distinct struct type, if the tag
  // is still unread (-1) AND the descriptor `ref.test`s as that struct, read
  // field 0 into `tagLocal`. Canonicalization makes the first shape-compatible
  // test succeed and expose a valid field-0 layout for the descriptor.
  fctx.body.push({ op: "i32.const", value: -1 });
  fctx.body.push({ op: "local.set", index: tagLocal });
  for (const structIdx of distinctStructIdxs) {
    fctx.body.push({ op: "local.get", index: tagLocal });
    fctx.body.push({ op: "i32.const", value: -1 });
    fctx.body.push({ op: "i32.eq" });
    fctx.body.push({ op: "local.get", index: descLocal });
    fctx.body.push({ op: "ref.test", typeIdx: structIdx });
    fctx.body.push({ op: "i32.and" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: descLocal },
        { op: "ref.cast", typeIdx: structIdx },
        { op: "struct.get", typeIdx: structIdx, fieldIdx: 0 },
        { op: "local.set", index: tagLocal },
      ],
      else: [],
    });
  }

  // Build a then-arm (coerce args → call <Class>_new → box) for one class.
  // `coerceType` / `pushDefaultValue` only emit into `fctx.body`, so build the
  // arm by temporarily redirecting `fctx.body` (the savedBody/swap pattern).
  const buildCtorArm = (className: string): Instr[] => {
    const ctorFuncIdx = ctx.funcMap.get(classMemberFuncKey(ctx, `${className}_new`))!;
    const paramTypes = getFuncParamTypes(ctx, ctorFuncIdx) ?? [];
    const arm: Instr[] = [];
    const savedBody = fctx.body;
    fctx.body = arm;
    for (let i = 0; i < paramTypes.length; i++) {
      const pType = paramTypes[i]!;
      if (useRuntimeArgv) {
        // Runtime argv: param i = (i < argc) ? box-coerce(argv[i]) : default.
        // The bounds check is RUNTIME because argc is only known at runtime.
        // Build the externref value first (argv[i] or null), then coerce to the
        // param ValType (or default-pad via pushDefaultValue when out of range).
        const elemExtern: Instr[] = [
          { op: "local.get", index: argvLocal },
          { op: "i32.const", value: i },
          { op: "array.get", typeIdx: objVecArrTypeIdx },
        ];
        const padArm: Instr[] = [];
        {
          const sb = fctx.body;
          fctx.body = padArm;
          pushDefaultValue(fctx, pType, ctx);
          fctx.body = sb;
        }
        const inRangeArm: Instr[] = [];
        {
          const sb = fctx.body;
          fctx.body = inRangeArm;
          for (const ins of elemExtern) fctx.body.push(ins);
          if (pType.kind !== "externref") coerceType(ctx, fctx, { kind: "externref" }, pType);
          fctx.body = sb;
        }
        // i < argc ? inRangeArm : padArm  (both yield a `pType` value)
        fctx.body.push({ op: "i32.const", value: i });
        fctx.body.push({ op: "local.get", index: argcLocal });
        fctx.body.push({ op: "i32.lt_s" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "val", type: pType },
          then: inRangeArm,
          else: padArm,
        });
      } else if (i < argLocals.length) {
        fctx.body.push({ op: "local.get", index: argLocals[i]! });
        if (pType.kind !== "externref") {
          coerceType(ctx, fctx, { kind: "externref" }, pType);
        }
      } else {
        pushDefaultValue(fctx, pType, ctx);
      }
    }
    // (#2026 PR-3b) Set new.target to the DISPATCHED class id before the ctor
    // call, mirroring the static `new C()` path (`emitSetNewTargetBeforeCall`).
    // Without this the new-target global keeps whatever the enclosing frame
    // left, so `new.target === K` inside a dynamically-constructed ctor read 0.
    // The id-based comparison (`compileBinaryExpression`'s new.target arm) then
    // matches `getOrAssignClassNewTargetId(className)`. No-op unless the module
    // uses new.target (`ctx.usesNewTarget`), so zero cost otherwise.
    emitSetNewTargetBeforeCall(ctx, fctx.body, className);
    fctx.body.push({ op: "call", funcIdx: ctorFuncIdx });
    // Box the instance to externref to match the dispatch `if` block type. Most
    // `<Class>_new` return `(ref $structIdx)` (an anyref subtype) → wrap with
    // `extern.convert_any`. But some class ctors already return externref
    // (externref-backed / builtin-bridged construction); converting an externref
    // again is invalid Wasm (`extern.convert_any[0] expected anyref, found
    // externref`), which broke ~20 test262 tests where a value-bound ctor (e.g.
    // a TypedArray constructor passed as `TA`) reached this fallback (#2026).
    // Read the ctor's real result type and only box when it is NOT externref.
    const ctorResult = getFuncResultType(ctx, ctorFuncIdx);
    if (!ctorResult || ctorResult.kind !== "externref") {
      fctx.body.push({ op: "extern.convert_any" });
    }
    fctx.body = savedBody;
    return arm;
  };

  // No-match base: the descriptor is not a known user class (tag == -1) — e.g.
  // a genuine host builtin like `Test262Error` that also reached the unknown-ctor
  // branch. Fall through to the legacy `__new_${ctorName}` host import using the
  // pre-evaluated externref args, so host builtins keep working. When no such
  // import exists, yield null (the legacy `else` branch did the same).
  // In standalone / WASI strict mode there is no `__new_` host import to fall
  // back to (it is not on the dual-mode allowlist), so the no-match base stays
  // pure-Wasm (null). Host mode falls through to the existing import so genuine
  // builtins (Test262Error, …) keep working.
  const hostImportName = `__new_${ctorName}`;
  const hostFuncIdx = noJsHost(ctx) ? undefined : ctx.funcMap.get(hostImportName);
  let noMatchBase: Instr[];
  if (useConstructClosureBase) {
    // (#3087) The runtime value isn't a compiled class (tag == -1) but is an
    // `any`-typed dynamic ctor — construct it via the host `__construct_closure`
    // bridge: build a JS argv from the pre-evaluated externref args, then call
    // `__construct_closure(calleeExternref, argv)`. The bridge throws the spec
    // `TypeError` if the runtime value is not a constructor, so this is correct
    // for ANY runtime value.
    const finalArrNew = ctx.funcMap.get("__js_array_new") ?? ccArrNewIdx!;
    const finalArrPush = ctx.funcMap.get("__js_array_push") ?? ccArrPushIdx!;
    const finalCc = ctx.funcMap.get("__construct_closure") ?? ccBridgeIdx!;
    const base: Instr[] = [];
    const savedBodyCc = fctx.body;
    fctx.body = base;
    fctx.body.push({ op: "call", funcIdx: finalArrNew });
    const ccArgvLocal = allocLocal(fctx, `__dynnew_ccargv_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: ccArgvLocal });
    if (useRuntimeArgv) {
      const ccIdxLocal = allocLocal(fctx, `__dynnew_ccidx_${fctx.locals.length}`, { kind: "i32" });
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "local.set", index: ccIdxLocal });
      const copyLoop: Instr[] = [
        { op: "local.get", index: ccIdxLocal },
        { op: "local.get", index: argcLocal },
        { op: "i32.ge_s" },
        { op: "br_if", depth: 1 },
        { op: "local.get", index: ccArgvLocal },
        { op: "local.get", index: argvLocal },
        { op: "local.get", index: ccIdxLocal },
        { op: "array.get", typeIdx: objVecArrTypeIdx },
        { op: "call", funcIdx: finalArrPush },
        { op: "local.get", index: ccIdxLocal },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "local.set", index: ccIdxLocal },
        { op: "br", depth: 0 },
      ];
      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [{ op: "loop", blockType: { kind: "empty" }, body: copyLoop }],
      });
    } else {
      for (const aLocal of argLocals) {
        fctx.body.push({ op: "local.get", index: ccArgvLocal });
        fctx.body.push({ op: "local.get", index: aLocal });
        fctx.body.push({ op: "call", funcIdx: finalArrPush });
      }
    }
    // The callee descriptor (anyref) → externref for the bridge's first param.
    fctx.body.push({ op: "local.get", index: descLocal });
    fctx.body.push({ op: "extern.convert_any" });
    fctx.body.push({ op: "local.get", index: ccArgvLocal });
    fctx.body.push({ op: "call", funcIdx: finalCc });
    fctx.body = savedBodyCc;
    noMatchBase = base;
  } else if (hostFuncIdx !== undefined) {
    const base: Instr[] = [];
    const savedBody2 = fctx.body;
    fctx.body = base;
    const hostParamTypes = getFuncParamTypes(ctx, hostFuncIdx) ?? [];
    for (let i = 0; i < argLocals.length; i++) {
      fctx.body.push({ op: "local.get", index: argLocals[i]! });
    }
    for (let i = argLocals.length; i < hostParamTypes.length; i++) {
      pushDefaultValue(fctx, hostParamTypes[i]!, ctx);
    }
    fctx.body.push({ op: "call", funcIdx: hostFuncIdx });
    fctx.body = savedBody2;
    noMatchBase = base;
  } else if (noJsHost(ctx) && !useRuntimeArgv) {
    // (#2872) Standalone/WASI unknown-ctor base: the runtime value may be a
    // first-class `$__ta_ctor` (the TypedArray-harness `function (TA) { new
    // TA(3) / new TA([…]) }` shape — the callee matched no user-class tag).
    // Route through the runtime-gated general TA construct; any other runtime
    // value keeps the pre-existing null-extern outcome (the ref.test declines).
    const base: Instr[] = [];
    const savedBase = fctx.body;
    fctx.body = base;
    emitTaDynCtorConstructFromLocals(ctx, fctx, descLocal, argLocals);
    fctx.body = savedBase;
    noMatchBase = base;
  } else if (noJsHost(ctx) && useRuntimeArgv) {
    // A runtime value that matches no compiled class tag has no [[Construct]].
    // Throw a real, catchable TypeError in host-free targets instead of
    // silently returning null. The host lane reaches the bridge above, whose
    // Reflect.construct probe provides the same IsConstructor semantics.
    const base: Instr[] = [];
    const savedBase = fctx.body;
    fctx.body = base;
    emitThrowTypeError(ctx, fctx, "is not a constructor");
    fctx.body = savedBase;
    noMatchBase = base;
  } else {
    noMatchBase = [{ op: "ref.null.extern" }];
  }

  // (2) Flat tag-equality dispatch over every candidate (innermost → host base).
  let chain: Instr[] = noMatchBase;
  for (const className of candidates) {
    const classTag = ctx.classTagMap.get(className) ?? 0;
    const thenArm = buildCtorArm(className);
    const elseArm = chain;
    chain = [
      { op: "local.get", index: tagLocal },
      { op: "i32.const", value: classTag },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: thenArm,
        else: elseArm,
      },
    ];
  }
  for (const instr of chain) fctx.body.push(instr);
  return true;
}

/**
 * (#2162) Seed a native Set (its `$Map` backing store, already built and held in
 * `collTmp`) from a NON-LITERAL array-typed argument — `new Set(arr)`,
 * `new Set(spreadVar)` — the dominant non-literal iterable form. The
 * array-literal form is handled inline by the constructor block; this covers the
 * variable / call-result vec.
 *
 * `arg` is compiled to a `$Vec` struct (`{length: i32, data: (ref $arr)}`); we
 * walk it with a counted Wasm loop, box each element, and call `__set_add`.
 *
 * ALWAYS leaves the collection ref on the stack (the caller returns it directly).
 * Returns true when the seed loop was emitted; false when the arg is not a usable
 * vec (the collection is left empty — graceful: never a host-import leak / CE).
 *
 * NOTE — Map(pairsVar) is intentionally out of this slice: the inner `[K,V]` pair
 * lowers to a typed *tuple struct* (`$__tuple_<n>`), not an inner vec, so its
 * extraction is a distinct shape (struct.get per field, varying field types). The
 * Map array-literal-of-pairs form is already handled inline; the non-literal Map
 * variable form falls back to an empty Map (no leak/CE) and is a follow-up.
 */
function seedNativeSetFromArrayArg(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arg: ts.Expression,
  collTmp: number,
  addFuncIdx: number,
): boolean {
  // Bail helper: drop a stray compiled value (if any) and restore the collection.
  const bail = (dropArg: boolean): boolean => {
    if (dropArg) fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "local.get", index: collTmp });
    return false;
  };
  // Compile the argument to its vec value.
  const argType = compileExpression(ctx, fctx, arg);
  if (argType === null) return bail(false);
  if (argType.kind !== "ref" && argType.kind !== "ref_null") return bail(true);
  const vecTypeIdx = (argType as { typeIdx: number }).typeIdx;
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  if (arrTypeIdx < 0) return bail(true);
  const arrDef = ctx.mod.types[arrTypeIdx];
  if (!arrDef || arrDef.kind !== "array") return bail(true);
  const elemType = arrDef.element;

  // Locals: the source vec, its data array, the loop index, the length.
  const vecLocal = allocLocal(fctx, `__collctor_vec_${fctx.locals.length}`, argType);
  const dataLocal = allocLocal(fctx, `__collctor_data_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: arrTypeIdx,
  });
  const idxLocal = allocLocal(fctx, `__collctor_i_${fctx.locals.length}`, { kind: "i32" });
  const lenLocal = allocLocal(fctx, `__collctor_len_${fctx.locals.length}`, { kind: "i32" });

  // vec → local; data = vec.data (field 1); len = vec.length (field 0); i = 0.
  fctx.body.push({ op: "local.set", index: vecLocal });
  fctx.body.push({ op: "local.get", index: vecLocal });
  fctx.body.push({ op: "ref.as_non_null" });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataLocal });
  fctx.body.push({ op: "local.get", index: vecLocal });
  fctx.body.push({ op: "ref.as_non_null" });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenLocal });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: idxLocal });

  // Build the per-element body inside a block/loop. The body reads data[i],
  // coerces to anyref, and calls __set_add with the collection.
  const loopBody: Instr[] = [];
  // break if i >= len
  loopBody.push({ op: "local.get", index: idxLocal });
  loopBody.push({ op: "local.get", index: lenLocal });
  loopBody.push({ op: "i32.ge_s" });
  loopBody.push({ op: "br_if", depth: 1 });
  // __set_add(coll, box(data[i]))  (returns ref $Map → drop)
  loopBody.push({ op: "local.get", index: collTmp });
  loopBody.push({ op: "local.get", index: dataLocal });
  loopBody.push({ op: "local.get", index: idxLocal });
  loopBody.push(emitArrayGetForElem(arrTypeIdx, elemType));
  emitCoerceElemToAnyrefInto(ctx, fctx, loopBody, elemType);
  loopBody.push({ op: "call", funcIdx: addFuncIdx });
  loopBody.push({ op: "drop" });

  // i += 1; continue
  loopBody.push({ op: "local.get", index: idxLocal });
  loopBody.push({ op: "i32.const", value: 1 });
  loopBody.push({ op: "i32.add" });
  loopBody.push({ op: "local.set", index: idxLocal });
  loopBody.push({ op: "br", depth: 0 });

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
  });

  // Leave the collection on the stack.
  fctx.body.push({ op: "local.get", index: collTmp });
  return true;
}

/**
 * (#2162 / #3572) `new WeakMap()` / `new WeakSet()` and their iterable
 * constructor forms in standalone / nativeStrings mode → the native
 * weak-collection runtime, which reuses the Map backing store (`__map_new`
 * yields the same `$Map`; the brand tag distinguishes them). Handled forms:
 *   - no-arg / `null` / `undefined` (all spec-empty);
 *   - an array LITERAL argument — WeakSet elements via `__weakset_add`, WeakMap
 *     `[key, value]` pairs via `__map_set` (mirrors the `new Set([…])` /
 *     `new Map([[k,v],…])` native seeding);
 *   - (WeakSet only) a non-literal array-typed argument → runtime vec walk.
 * Other forms (a general iterator with observable protocol steps — the
 * `iterator-*-failure` tests) return `undefined` so the caller falls through to
 * the generic ctor path, rather than leak a `WeakMap_new`/`WeakSet_new` host
 * import. Returns the constructed collection's ValType when handled.
 */
function tryCompileNativeWeakCollectionNew(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.NewExpression,
): ValType | undefined {
  if (
    !ctx.nativeStrings ||
    !ts.isIdentifier(expr.expression) ||
    (expr.expression.text !== "WeakMap" && expr.expression.text !== "WeakSet")
  ) {
    return undefined;
  }
  const isWeakMap = expr.expression.text === "WeakMap";
  const wcArgs = expr.arguments ?? ([] as readonly ts.Expression[]);
  // A single `null` / `undefined` argument is spec-equivalent to no-arg (empty).
  const nullishArg =
    wcArgs.length === 1 &&
    (wcArgs[0]!.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(wcArgs[0]!) && wcArgs[0]!.text === "undefined"));
  const wcArrArg = wcArgs.length === 1 && ts.isArrayLiteralExpression(wcArgs[0]!) ? wcArgs[0]! : undefined;
  // WeakMap array-literal seeding requires every element to be a 2-element
  // array literal (a `[key, value]` pair), mirroring `new Map([[k,v],…])`.
  const seedableMapPairs =
    isWeakMap &&
    wcArrArg !== undefined &&
    wcArrArg.elements.every(
      (e) => ts.isArrayLiteralExpression(e) && e.elements.length === 2 && !e.elements.some(ts.isSpreadElement),
    );
  const seedableSetElems =
    !isWeakMap && wcArrArg !== undefined && !wcArrArg.elements.some((e) => ts.isSpreadElement(e));
  // WeakSet only: a non-literal array-typed argument → runtime vec walk (mirror Set).
  const wcNonLiteralArrArg =
    !isWeakMap && wcArgs.length === 1 && wcArrArg === undefined && !nullishArg && isArrayTypedArg(ctx, wcArgs[0]!)
      ? wcArgs[0]!
      : undefined;
  const wcHandled =
    wcArgs.length === 0 || nullishArg || seedableMapPairs || seedableSetElems || wcNonLiteralArrArg !== undefined;
  if (!wcHandled) return undefined;

  addUnionImports(ctx);
  ensureWeakCollectionHelpers(ctx);
  const mapNewIdx = ctx.mapHelpers.get("__map_new");
  const mapSetIdx = ctx.mapHelpers.get("__map_set");
  const weaksetAddIdx = ctx.mapHelpers.get("__weakset_add");
  if (mapNewIdx === undefined || ctx.mapTypeIdx < 0) return undefined;

  fctx.body.push({
    op: "i32.const",
    value: isWeakMap ? COLLECTION_KIND.WEAKMAP : COLLECTION_KIND.WEAKSET,
  }); // (#3171) brand tag
  fctx.body.push({ op: "call", funcIdx: mapNewIdx });
  if (seedableMapPairs && wcArrArg !== undefined && wcArrArg.elements.length > 0 && mapSetIdx !== undefined) {
    const mTmp = allocLocal(fctx, `__wmctor_m_${fctx.locals.length}`, { kind: "ref", typeIdx: ctx.mapTypeIdx });
    fctx.body.push({ op: "local.set", index: mTmp });
    for (const el of wcArrArg.elements) {
      // every() above narrowed each element to a 2-element array literal.
      const pair = el as ts.ArrayLiteralExpression;
      fctx.body.push({ op: "local.get", index: mTmp });
      const kt = compileExpression(ctx, fctx, pair.elements[0]!);
      coerceMapKeyToAnyref(ctx, fctx, kt);
      const vt = compileExpression(ctx, fctx, pair.elements[1]!);
      coerceMapKeyToAnyref(ctx, fctx, vt);
      fctx.body.push({ op: "call", funcIdx: mapSetIdx }); // returns ref $Map
      fctx.body.push({ op: "drop" });
    }
    fctx.body.push({ op: "local.get", index: mTmp });
  } else if (
    seedableSetElems &&
    wcArrArg !== undefined &&
    wcArrArg.elements.length > 0 &&
    weaksetAddIdx !== undefined
  ) {
    const mTmp = allocLocal(fctx, `__wsctor_m_${fctx.locals.length}`, { kind: "ref", typeIdx: ctx.mapTypeIdx });
    fctx.body.push({ op: "local.set", index: mTmp });
    for (const el of wcArrArg.elements) {
      if (ts.isOmittedExpression(el)) continue; // hole → undefined element
      fctx.body.push({ op: "local.get", index: mTmp });
      const et = compileExpression(ctx, fctx, el);
      coerceMapKeyToAnyref(ctx, fctx, et);
      fctx.body.push({ op: "call", funcIdx: weaksetAddIdx }); // returns ref $Map
      fctx.body.push({ op: "drop" });
    }
    fctx.body.push({ op: "local.get", index: mTmp });
  } else if (wcNonLiteralArrArg !== undefined && weaksetAddIdx !== undefined) {
    const mTmp = allocLocal(fctx, `__wsctor_m_${fctx.locals.length}`, { kind: "ref", typeIdx: ctx.mapTypeIdx });
    fctx.body.push({ op: "local.set", index: mTmp });
    // On a non-vec / unsupported-element arg the helper leaves the empty
    // collection on the stack (graceful: empty WeakSet, never a host leak).
    seedNativeSetFromArrayArg(ctx, fctx, wcNonLiteralArrArg, mTmp, weaksetAddIdx);
  }
  return { kind: "ref", typeIdx: ctx.mapTypeIdx };
}

/**
 * (#2162) Is `arg`'s static type an array (`T[]` / `Array<T>` / readonly array /
 * a tuple)? Used to recognise the non-literal iterable form of `new Set(arr)` /
 * `new Map(pairs)`. Conservative: only a checker-confirmed array/tuple type
 * qualifies, so a plain identifier of a non-array type never routes here.
 */
function isArrayTypedArg(ctx: CodegenContext, arg: ts.Expression): boolean {
  // A spread inside the constructor arg list is grammatically not a single arg
  // here (handled at the array-literal layer); guard anyway.
  if (ts.isSpreadElement(arg)) return false;
  const t = ctx.checker.getTypeAtLocation(arg);
  // ts.TypeChecker exposes isArrayType/isTupleType on the internal API used
  // elsewhere in the codebase; fall back to apparent-type number-index probing.
  const checkerAny = ctx.checker as unknown as {
    isArrayType?: (t: ts.Type) => boolean;
    isTupleType?: (t: ts.Type) => boolean;
    isArrayLikeType?: (t: ts.Type) => boolean;
  };
  if (checkerAny.isArrayType?.(t)) return true;
  if (checkerAny.isTupleType?.(t)) return true;
  // Apparent-type fallback: a numeric index signature + a `length` member is the
  // array-like shape. Avoids matching plain objects (no number index sig).
  const apparent = ctx.checker.getApparentType(t);
  const numIndex = apparent.getNumberIndexType?.();
  const hasLength = apparent.getProperty?.("length") !== undefined;
  return numIndex !== undefined && hasLength;
}

/** array.get with the per-kind sign extension for packed element types. */
function emitArrayGetForElem(arrTypeIdx: number, elemType: ValType): Instr {
  const op = elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";
  return { op, typeIdx: arrTypeIdx };
}

/**
 * Coerce a vec element (already on the stack, type `elemType`) to anyref for a
 * collection key/value, appending into `out`. Mirrors `coerceMapKeyToAnyref` but
 * targets an arbitrary instruction buffer (the loop body, not `fctx.body`).
 */
function emitCoerceElemToAnyrefInto(ctx: CodegenContext, fctx: FunctionContext, out: Instr[], elemType: ValType): void {
  // Reuse coerceMapKeyToAnyref by temporarily swapping the body buffer: it pushes
  // onto fctx.body. We splice those instructions into `out`.
  const saved = fctx.body;
  const scratch: Instr[] = [];
  fctx.body = scratch;
  try {
    coerceMapKeyToAnyref(ctx, fctx, elemType);
  } finally {
    fctx.body = saved;
  }
  for (const instr of scratch) out.push(instr);
}

function compileNewExpression(ctx: CodegenContext, fctx: FunctionContext, expr: ts.NewExpression): ValType | null {
  // (#3927 per-type layouts) Publish the allocation-label hint when this `new`
  // is a recorded label site of a split family. BEFORE the arguments compile —
  // a labelled allocation nested in them consumes and resets the hint, so the
  // outer allocation degrades to the union layout (fat, never narrow).
  maybeEmitLayoutHint(ctx, fctx, expr);

  // (#1528b) Unwrap parens AND `as`/`!`/type-assertion wrappers so the static
  // non-constructor guards below still fire on `new ((() => {}) as any)()` etc.
  // — the bare paren-only unwrap let cast arrows slip through to the dynamic
  // path and silently no-throw. Mirrors the builtin-namespace unwrap below.
  const unwrapNewTarget = (e: ts.Expression): ts.Expression => {
    let cur = e;
    while (
      ts.isParenthesizedExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isNonNullExpression(cur) ||
      ts.isTypeAssertionExpression(cur)
    ) {
      cur = ts.isParenthesizedExpression(cur)
        ? cur.expression
        : ts.isAsExpression(cur)
          ? cur.expression
          : ts.isNonNullExpression(cur)
            ? cur.expression
            : (cur as ts.TypeAssertion).expression;
    }
    return cur;
  };

  // Handle `new function() { ... }(args)` and the canonical parenthesized
  // `new (function() { ... })(args)` spelling through the same source-body
  // constructor path. The paren-only form previously fell through to a null
  // placeholder without evaluating the constructor body at all.
  const unwrappedLiteralCtor = unwrapNewTarget(expr.expression);
  if (ts.isFunctionExpression(unwrappedLiteralCtor)) {
    return compileNewFunctionExpression(ctx, fctx, expr, unwrappedLiteralCtor);
  }

  // TextEncoder/TextDecoder are standard Web/Node classes, but standalone and
  // WASI builds cannot depend on host `env.TextEncoder_*` imports. The instance
  // carries no state for the UTF-8-only surface implemented here, so the native
  // method fast paths use this evaluated placeholder receiver.
  if ((noJsHost(ctx) || ctx.strictNoHostImports) && ctx.nativeStrings && ts.isIdentifier(expr.expression)) {
    const ctorName = expr.expression.text;
    if (ctorName === "TextEncoder" || ctorName === "TextDecoder") {
      const args = expr.arguments ?? [];
      for (const arg of args) {
        const argType = compileExpression(ctx, fctx, arg);
        if (argType !== null) fctx.body.push({ op: "drop" });
      }
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }
  }

  {
    const temporalResult = compileTemporalNewExpression(ctx, fctx, expr);
    if (temporalResult !== undefined) return temporalResult;
  }

  // (#1103a) `new Map()` in standalone / nativeStrings mode → the WasmGC-native
  // Map runtime (map-runtime.ts) instead of a `Map_new` host import. `new Map()`
  // is a NewExpression, so the interception must live here (not in the
  // call-expression compiler). Slice 1: no-arg form only — `new Map(iterable)`
  // needs `__map_new_from_arr` (slice 2) and falls through. Returns `ref $Map`
  // so the binding/receiver is typed (see resolveWasmType Map case + the
  // method/.size dispatch in extern.ts / property-access.ts).
  // (#3231) `new DisposableStack()` in standalone / nativeStrings mode → the
  // WasmGC-native DisposableStack runtime (externref-carried struct). The ctor
  // takes no args (extra args ignored per spec). AsyncDisposableStack is Phase 2
  // and keeps the host `AsyncDisposableStack_new` path.
  if (ctx.nativeStrings && ts.isIdentifier(expr.expression) && expr.expression.text === "DisposableStack") {
    addUnionImports(ctx);
    const newIdx = ensureDisposableStackNew(ctx);
    fctx.body.push({ op: "call", funcIdx: newIdx });
    return { kind: "externref" };
  }

  if (ctx.nativeStrings && ts.isIdentifier(expr.expression) && expr.expression.text === "Map") {
    const args = expr.arguments ?? ([] as readonly ts.Expression[]);
    // `new Map([[k,v],...])` — an array literal of 2-element array-literal pairs
    // (the dominant iterable form). Each pair seeds the map via `__map_set`. Any
    // non-array-literal element (spread, a variable, a non-pair) makes us fall
    // back to the empty map (the general iterator drive is a follow-up slice).
    const arrArg = args.length === 1 && ts.isArrayLiteralExpression(args[0]!) ? args[0]! : undefined;
    const seedablePairs =
      arrArg !== undefined &&
      arrArg.elements.every(
        (e) => ts.isArrayLiteralExpression(e) && e.elements.length === 2 && !e.elements.some(ts.isSpreadElement),
      );
    // (#2162) Map from a NON-literal array-of-pairs variable is a follow-up: the
    // inner `[K,V]` pair lowers to a typed tuple *struct* (not an inner vec), so
    // its extraction differs from the Set element walk. The array-literal-of-pairs
    // form is handled below; a non-literal Map arg falls through to the empty map.
    if (args.length === 0 || seedablePairs) {
      addUnionImports(ctx);
      ensureMapHelpers(ctx);
      const mapNewIdx = ctx.mapHelpers.get("__map_new");
      const mapSetIdx = ctx.mapHelpers.get("__map_set");
      if (mapNewIdx !== undefined && ctx.mapTypeIdx >= 0) {
        fctx.body.push({ op: "i32.const", value: COLLECTION_KIND.MAP }); // (#3171) brand tag
        fctx.body.push({ op: "call", funcIdx: mapNewIdx });
        if (seedablePairs && arrArg !== undefined && arrArg.elements.length > 0 && mapSetIdx !== undefined) {
          const mTmp = allocLocal(fctx, `__mapctor_m_${fctx.locals.length}`, {
            kind: "ref",
            typeIdx: ctx.mapTypeIdx,
          });
          fctx.body.push({ op: "local.set", index: mTmp });
          for (const el of arrArg.elements) {
            // every() above narrowed each element to a 2-element array literal.
            const pair = el as ts.ArrayLiteralExpression;
            fctx.body.push({ op: "local.get", index: mTmp });
            const kt = compileExpression(ctx, fctx, pair.elements[0]!);
            coerceMapKeyToAnyref(ctx, fctx, kt);
            const vt = compileExpression(ctx, fctx, pair.elements[1]!);
            coerceMapKeyToAnyref(ctx, fctx, vt);
            fctx.body.push({ op: "call", funcIdx: mapSetIdx }); // returns ref $Map
            fctx.body.push({ op: "drop" });
          }
          fctx.body.push({ op: "local.get", index: mTmp });
        }
        return { kind: "ref", typeIdx: ctx.mapTypeIdx };
      }
    }
  }

  // (#2162) `new Set()` / `new Set([...])` in standalone / nativeStrings mode →
  // the WasmGC-native Set runtime, which reuses the Map backing store
  // (`__map_new` yields the same empty `$Map` a Set wraps). The no-arg form
  // builds an empty Set; an ARRAY-LITERAL argument (`new Set([1,2,3])`, the
  // dominant iterable form) seeds it element-by-element via `__set_add` (which
  // dedups through the shared Map insert). A non-literal iterable still needs
  // the general iterator drive (follow-up slice) and falls through.
  if (ctx.nativeStrings && ts.isIdentifier(expr.expression) && expr.expression.text === "Set") {
    const args = expr.arguments ?? ([] as readonly ts.Expression[]);
    const arrArg = args.length === 1 && ts.isArrayLiteralExpression(args[0]!) ? args[0]! : undefined;
    // (#2162) A single NON-literal argument whose static type is an array (a
    // variable, a spread that lowered to a vec, `[...set]`, a call result) is the
    // dominant non-literal iterable form — seed it via a runtime vec walk.
    const nonLiteralArrArg =
      args.length === 1 && arrArg === undefined && isArrayTypedArg(ctx, args[0]!) ? args[0]! : undefined;
    if (args.length === 0 || arrArg || nonLiteralArrArg) {
      addUnionImports(ctx);
      ensureSetHelpers(ctx);
      const mapNewIdx = ctx.mapHelpers.get("__map_new");
      const setAddIdx = ctx.mapHelpers.get("__set_add");
      if (mapNewIdx !== undefined && ctx.mapTypeIdx >= 0) {
        fctx.body.push({ op: "i32.const", value: COLLECTION_KIND.SET }); // (#3171) brand tag
        fctx.body.push({ op: "call", funcIdx: mapNewIdx });
        if (arrArg && setAddIdx !== undefined && !arrArg.elements.some((e) => ts.isSpreadElement(e))) {
          const mTmp = allocLocal(fctx, `__setctor_m_${fctx.locals.length}`, {
            kind: "ref",
            typeIdx: ctx.mapTypeIdx,
          });
          fctx.body.push({ op: "local.set", index: mTmp });
          for (const el of arrArg.elements) {
            if (ts.isOmittedExpression(el)) continue; // hole → undefined element
            fctx.body.push({ op: "local.get", index: mTmp });
            const et = compileExpression(ctx, fctx, el);
            coerceMapKeyToAnyref(ctx, fctx, et);
            fctx.body.push({ op: "call", funcIdx: setAddIdx }); // returns ref $Map
            fctx.body.push({ op: "drop" }); // discard chained set
          }
          fctx.body.push({ op: "local.get", index: mTmp });
        } else if (nonLiteralArrArg && setAddIdx !== undefined) {
          const mTmp = allocLocal(fctx, `__setctor_m_${fctx.locals.length}`, {
            kind: "ref",
            typeIdx: ctx.mapTypeIdx,
          });
          fctx.body.push({ op: "local.set", index: mTmp });
          // On a non-vec / unsupported-element arg the helper leaves the empty
          // collection on the stack (graceful: empty Set, never a host-import leak).
          seedNativeSetFromArrayArg(ctx, fctx, nonLiteralArrArg, mTmp, setAddIdx);
        }
        return { kind: "ref", typeIdx: ctx.mapTypeIdx };
      }
    }
  }

  // (#2162 / #3572) `new WeakMap()` / `new WeakSet()` + iterable ctor forms →
  // native weak-collection runtime (see tryCompileNativeWeakCollectionNew).
  {
    const weakCollResult = tryCompileNativeWeakCollectionNew(ctx, fctx, expr);
    if (weakCollResult !== undefined) return weakCollResult;
  }

  // (#3242) `new WeakRef(target)` in standalone / nativeStrings mode → the
  // native `$WeakRef` struct (single anyref target field). Without this the
  // generic externClass ctor table emits a `WeakRef_new` host import the
  // standalone runtime can't satisfy. Strong-backed (no real GC weakness); see
  // weakref-runtime.ts. Requires exactly one arg — other arities fall through.
  if (
    ctx.nativeStrings &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "WeakRef" &&
    (expr.arguments?.length ?? 0) === 1
  ) {
    addUnionImports(ctx); // register __box_number before the target coerce (idempotent)
    const weakRefResult = tryCompileNativeWeakRefNew(ctx, fctx, expr);
    if (weakRefResult !== undefined) return weakRefResult;
  }

  // Arrow functions are NOT constructors — `new (() => {})` throws TypeError (#730)
  {
    const unwrappedNew = unwrapNewTarget(expr.expression);
    if (ts.isArrowFunction(unwrappedNew)) {
      // #1528: throw a real TypeError instance so `assert.throws(TypeError, …)`
      // catches it (the bare-string throw is only `instanceof Error`/string).
      return emitStaticNotAConstructorThrow(ctx, fctx, []);
    }
  }

  // (#4246) `new <provably-not-a-constructor>` — a primitive value, or the
  // result of another `new` — throws TypeError (§13.3.5.1 step 4). Placed
  // after the intrinsic-name interceptions above (Map/Set/WeakRef/Temporal),
  // which key on an identifier that could never carry one of these facts, and
  // before the class-expression / unknown-constructor paths that would
  // otherwise swallow the construction and answer `undefined`.
  {
    const nonCtorValue = tryNonConstructableNewTarget(ctx, fctx, expr);
    if (nonCtorValue !== undefined) return nonCtorValue;
  }

  // Handle `new (class { ... })()` — anonymous class expression in new
  // Unwrap parenthesized expressions to find the class expression
  {
    let unwrappedExpr: ts.Expression = expr.expression;
    while (ts.isParenthesizedExpression(unwrappedExpr)) {
      unwrappedExpr = unwrappedExpr.expression;
    }
    if (ts.isClassExpression(unwrappedExpr)) {
      // Look up the synthetic name assigned during the collection phase
      const syntheticName = ctx.anonClassExprNames.get(unwrappedExpr);
      if (syntheticName) {
        const ctorName = `${syntheticName}_new`;
        const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, ctorName)); // (#1983)
        if (funcIdx === undefined) {
          reportError(ctx, expr, `Missing constructor for anonymous class`);
          return null;
        }

        const paramTypes = getFuncParamTypes(ctx, funcIdx);
        const args = expr.arguments ?? [];
        for (let i = 0; i < args.length; i++) {
          compileExpression(ctx, fctx, args[i]!, paramTypes?.[i]);
        }
        if (paramTypes) {
          for (let i = args.length; i < paramTypes.length; i++) {
            pushDefaultValue(fctx, paramTypes[i]!, ctx);
          }
        }

        fctx.body.push({ op: "call", funcIdx });
        const structTypeIdx = ctx.structMap.get(syntheticName)!;
        return { kind: "ref", typeIdx: structTypeIdx };
      }
    }
  }

  // Non-identifier constructor: detect non-constructable functions.
  // (#1528b) Unwrap `as`/`!`/type-assertion/paren wrappers so the guards fire
  // on `new (Array.prototype.map as any)()` etc., not just the bare form.
  const unwrappedNonId = unwrapNewTarget(expr.expression);
  if (!ts.isIdentifier(unwrappedNonId) && !ts.isFunctionExpression(unwrappedNonId)) {
    // Pattern 1: `new X.prototype.Y()` — prototype methods are NEVER constructors.
    // This covers both ES2022 (forEach) and ES2023 (with, toSorted) methods,
    // even when TypeScript lib doesn't know about the method (type resolves to `any`).
    if (ts.isPropertyAccessExpression(unwrappedNonId)) {
      const obj = unwrappedNonId.expression; // e.g. Array.prototype
      if (isNewOnNonConstructablePrototype(ctx, unwrappedNonId)) {
        return emitStaticNotAConstructorThrow(ctx, fctx, []);
      }
      if (isNewOnUnmodifiedDateInstanceMethod(ctx, unwrappedNonId)) {
        return emitStaticMemberNotAConstructorThrow(ctx, fctx, unwrappedNonId, expr.arguments ?? []);
      }
      // (#1732 S2) `new <NonCtorNamespace>.<method>()` — a method pulled off a
      // non-constructor namespace object (Math/JSON/Reflect/Atomics). Every such
      // method is an ordinary function with no [[Construct]] (§21.3/§25.5/§28.1/
      // §25.4), so `new` must throw TypeError. Pattern 2 below only fires when
      // the TS lib KNOWS the method has call-sigs/no-construct-sigs; methods
      // NEWER than the bundled lib (e.g. `Math.f16round`, `Math.sumPrecise`)
      // resolve to `any`, slip past Pattern 2, and reach the unknown-ctor path
      // which never performs [[Construct]] and so wrongly returns instead of
      // throwing (test262 built-ins/Math/f16round/not-a-constructor.js etc.).
      // Keying on the namespace NAME makes the guard lib-version-independent —
      // it fires for any current or future Math/JSON/Reflect/Atomics method. The
      // receiver-name match is intentionally narrow to those four built-ins
      // (the same discipline as the namespace-identifier guard below).
      if (ts.isIdentifier(obj)) {
        const NS_NON_CONSTRUCTORS = new Set(["Math", "JSON", "Reflect", "Atomics"]);
        if (NS_NON_CONSTRUCTORS.has(obj.text)) {
          return emitStaticNotAConstructorThrow(ctx, fctx, []);
        }
      }
    }

    // Pattern 2: TypeScript knows the expression has call sigs but no construct sigs.
    // e.g. `new decodeURIComponent()`, `new Math.abs()`, `new Array.from()`.
    // Resolve on the unwrapped target so a cast doesn't widen it to `any`.
    //
    // (#2608) EXCEPT `new this(...)`: inside a function-constructor (fnctor) static
    // method, the checker types `this` as the bare `function`-value, which has CALL
    // signatures but NO construct signatures — so this guard would wrongly throw
    // "is not a constructor". But `this` IS a constructable function-value at runtime
    // (e.g. acorn's `Parser.parse = function(){ return new this(opts, src) }`, where
    // `this === Parser`). Let a `this` callee fall through to the `__construct_closure`
    // bridge arm below (JS-host), which constructs the runtime closure value directly.
    const exprType = ctx.checker.getTypeAtLocation(unwrappedNonId);
    const constructSigs = ctx.checker.getSignaturesOfType(exprType, ts.SignatureKind.Construct);
    const callSigs = ctx.checker.getSignaturesOfType(exprType, ts.SignatureKind.Call);
    if (unwrappedNonId.kind !== ts.SyntaxKind.ThisKeyword && callSigs.length > 0 && constructSigs.length === 0) {
      // #1528: real TypeError instance — spec requires `Construct(F)` to throw
      // `TypeError("F is not a constructor")` when F has no [[Construct]].
      return emitStaticNotAConstructorThrow(ctx, fctx, []);
    }
  }

  // (#1519 sub-issue B) Built-in non-constructor namespaces — `Math`, `JSON`,
  // `Reflect`, `Atomics` — have neither call nor construct signatures. Per
  // ECMA-262 §7.2.10 IsConstructor, `new`-on a value lacking `[[Construct]]`
  // must throw TypeError. We detect them by name on the unwrapped expression
  // (so `new Math()`, `new (Math)()`, and `new (Math as any)()` all fire).
  // User-defined identifier shadowing keeps its own value-type with
  // construct signatures, so this fires only for the actual builtin symbols
  // (verified via the type checker's `Math`/`JSON`/`Reflect`/`Atomics`
  // namespace lookups in lib.es*.d.ts).
  {
    let unwrapped: ts.Expression = expr.expression;
    while (
      ts.isParenthesizedExpression(unwrapped) ||
      ts.isAsExpression(unwrapped) ||
      ts.isNonNullExpression(unwrapped) ||
      ts.isTypeAssertionExpression(unwrapped)
    ) {
      unwrapped = ts.isParenthesizedExpression(unwrapped)
        ? unwrapped.expression
        : ts.isAsExpression(unwrapped)
          ? unwrapped.expression
          : ts.isNonNullExpression(unwrapped)
            ? unwrapped.expression
            : (unwrapped as ts.TypeAssertion).expression;
    }
    if (ts.isIdentifier(unwrapped)) {
      const name = unwrapped.text;
      const NAMESPACE_NON_CONSTRUCTORS = new Set(["Math", "JSON", "Reflect", "Atomics"]);
      if (NAMESPACE_NON_CONSTRUCTORS.has(name)) {
        // Use the real-TypeError throw path so `assert.throws(TypeError, …)`
        // in test262 negative cases (S11.2.2_A4_T*) observes a TypeError
        // instance, not a bare string. Falls back to a string throw when
        // `__new_TypeError` isn't registered (standalone mode).
        emitThrowTypeError(ctx, fctx, `${name} is not a constructor`);
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }
      // (#2886) Global builtin FUNCTIONS that lack [[Construct]] — `new
      // decodeURI()`, `new parseFloat()`, etc. Without this, the callee falls
      // through to the unknown-ctor path and is mis-routed to an `extern_class`
      // host import, which throws a bare `Error: No dependency provided for
      // extern class "decodeURI"` at runtime — not a `TypeError`. The Sputnik
      // `S15.1.*_A5.7`/`A7.7` tests strictly check `e instanceof TypeError`.
      // Gate on the ambient-global binding so a user-defined shadow (e.g.
      // `function parseInt(){}`, which IS constructable) keeps the normal path.
      if (
        GLOBAL_NON_CONSTRUCTOR_FUNCTIONS.has(name) &&
        !ctx.classSet.has(name) &&
        !ctx.externClasses.has(name) &&
        resolvesToAmbientGlobal(ctx, unwrapped)
      ) {
        emitThrowTypeError(ctx, fctx, `${name} is not a constructor`);
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }
    }
  }

  // Handle `new Promise(executor)` and the other built-in global
  // constructors (Number/String/Boolean wrappers, the Error family,
  // AggregateError, SuppressedError, Object, Proxy, Function, Date,
  // TypedArray) — extracted to new-builtin-globals.ts (#3281 slice 1).
  // Byte-identical sentinel lift.
  {
    const r = tryCompileBuiltinGlobalNew(ctx, fctx, expr);
    if (r !== NEW_GLOBAL_FALLTHROUGH) return r;
  }

  const type = ctx.checker.getTypeAtLocation(expr);
  const symbol = type.getSymbol();
  let className = symbol?.name;
  // (#2681/#2686 A1) The fnctor symbol for a `new this()` callee, resolved from
  // the enclosing method's owner fnctor (the type symbol of `new this()` is
  // `any`/none, so `symbol` is undefined). Used by the #1679 build path below.
  let thisFnctorSym: ts.Symbol | undefined;

  // (#3163) Resolve the callee identifier THROUGH cast/paren wrappers —
  // `new (P as any)()` must construct exactly like `new P()`. The raw-node
  // `ts.isIdentifier(expr.expression)` gates below made every cast-wrapped
  // identifier callee (the natural minimal-repro shape, and the "ctor stored
  // behind an `any` cast" idiom) miss the class/fnctor arms and fall through
  // to the dynamic path, which yielded null. `unwrappedNonId` is the #1528b
  // unwrap (parens / `as` / `!` / type assertions) computed above; a cast
  // never changes the runtime VALUE, so symbol resolution on the unwrapped
  // identifier reflects the actual binding.
  const calleeIdent = ts.isIdentifier(unwrappedNonId) ? unwrappedNonId : undefined;

  // (#4288) Published JavaScript commonly spells classes as `var C = class {}`.
  // TypeScript gives every one of those anonymous class types the display name
  // `__class`, which is not a binding identity: a global string lookup is
  // necessarily last-writer-wins across modules. Follow the direct callee's
  // symbol (and import alias) to the exact ClassExpression AST node first, then
  // recover the synthetic name registered for that node. Hono imports three
  // such router classes; without this identity path each `new Router()` became
  // `new Hono()` and recursively re-entered Hono's initializer.
  let boundClassExpressionName: string | undefined;
  if (calleeIdent) {
    let boundSymbol = ctx.checker.getSymbolAtLocation(calleeIdent);
    const seenAliases = new Set<ts.Symbol>();
    while (boundSymbol && (boundSymbol.flags & ts.SymbolFlags.Alias) !== 0 && !seenAliases.has(boundSymbol)) {
      seenAliases.add(boundSymbol);
      try {
        const target = ctx.checker.getAliasedSymbol(boundSymbol);
        if (target === boundSymbol) break;
        boundSymbol = target;
      } catch {
        break;
      }
    }
    for (const declaration of boundSymbol?.getDeclarations() ?? []) {
      const initializer = ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined;
      const candidate = initializer ? unwrapNewTarget(initializer) : declaration;
      if (!ts.isClassExpression(candidate)) continue;
      const syntheticName = ctx.anonClassExprNames.get(candidate);
      if (syntheticName && ctx.classSet.has(syntheticName)) {
        boundClassExpressionName = syntheticName;
        break;
      }
    }
  }

  if (boundClassExpressionName) {
    className = boundClassExpressionName;
  } else if (className && !ctx.classSet.has(className)) {
    // Compatibility fallback for class expressions whose exact binding is not
    // statically available (for example `let C; C = class {}`). Internal symbol
    // names are safe here only after the exact declaration path above missed.
    const mapped = ctx.classExprNameMap.get(className);
    if (mapped) {
      className = mapped;
    }
  }
  // #3371: a compiler-synthesized `new` used by standalone Reflect.construct
  // has no checker-owned type for the synthetic NewExpression itself. The
  // callee is still the original source identifier, so retain the exact native
  // indexed-constructor identity instead of misrouting DataView/TypedArray to
  // the dynamic-any constructor fallback.
  if (
    !className &&
    calleeIdent &&
    (calleeIdent.text === "Array" ||
      calleeIdent.text === "ArrayBuffer" ||
      calleeIdent.text === "SharedArrayBuffer" ||
      calleeIdent.text === "DataView" ||
      TYPED_ARRAY_NAMES.has(calleeIdent.text))
  ) {
    className = calleeIdent.text;
  }
  // Preprocessing may upgrade a JavaScript file to TypeScript grammar to host
  // injected declarations (timers/import shims). In large vendor bundles the
  // checker can then return `any` with no symbol for a plainly spelled ambient
  // constructor such as `new Map()`. The extern-import prepass has a matching
  // syntactic fallback; recover the same class identity here so codegen calls
  // `Map_new` instead of falling through to an absent `__new_Map` and silently
  // producing null. `resolvesToAmbientGlobal` excludes every user shadow.
  if (
    !className &&
    calleeIdent &&
    ctx.externClasses.has(calleeIdent.text) &&
    resolvesToAmbientGlobal(ctx, calleeIdent)
  ) {
    className = calleeIdent.text;
  }
  if ((!className || !ctx.classSet.has(className)) && calleeIdent) {
    const idName = calleeIdent.text;
    if (ctx.classSet.has(idName)) {
      className = idName;
    } else {
      // Check classExprNameMap — for `let C: any; C = class { ... }; new C()`,
      // the identifier C maps to the synthetic class name via classExprNameMap.
      const mapped = ctx.classExprNameMap.get(idName);
      if (mapped && ctx.classSet.has(mapped)) {
        className = mapped;
      }
    }
  }

  // (#2681/#2686 A1) `new this(...)` inside a fnctor static/prototype method
  // whose enclosing owner fnctor is APPROVED for reconstruction (escape gate,
  // A2). On current main the checker types `new this()` as `any`/no-symbol, so
  // `className` is undefined and the #1679 arm below is skipped — the fnctor
  // (acorn's Parser) stays a dynamic `$Object`/host-proxy externref and its
  // `this.<field>` reads diverge from the native struct (the #2681 switch-default
  // / #2686 operator-compare throw). Resolve the owner fnctor F here so
  // `className = F`, routing through the #1679 native-struct build path
  // (`compileNewFunctionDeclaration` → `__fnctor_F`). Gated on `approvedNames`
  // so every OTHER `new this()` fnctor keeps its existing host-bridge (#2608) /
  // dynamic lowering — no regression.
  if ((!className || !ctx.classSet.has(className)) && expr.expression.kind === ts.SyntaxKind.ThisKeyword) {
    const owner = resolveEnclosingFnctorOwner(ctx.checker, expr);
    if (owner && ctx.fnctorEscapeGate?.approvedNames.has(owner.name)) {
      className = owner.name;
      thisFnctorSym = owner.sym;
    }
  }

  // #682 — standalone mode supports a reduced native RegExp subset for static
  // literal patterns. Unsupported constructor forms still produce explicit
  // #1474-compatible compile errors instead of JS-host imports.
  if (
    ctx.targetProfile.semanticProviders === "native-first" &&
    (isGlobalRegExpType(type) || (ts.isIdentifier(expr.expression) && isGlobalRegExpIdentifier(ctx, expr.expression)))
  ) {
    return compileStandaloneRegExpConstructor(ctx, fctx, expr.arguments ?? [], expr);
  }

  // #1679 — `new this(...)` inside a static method: the callee is `this`, which
  // the checker resolves to the enclosing constructor (e.g. acorn's `Parser`
  // function-style class). It is not an identifier, so the function-constructor
  // path below is skipped. Route a `this`-callee that resolves to a known
  // function-style constructor (or one we can build from its declaration) to the
  // same `<Class>_new` machinery, keyed by the resolved className.
  if (className && !ctx.classSet.has(className) && expr.expression.kind === ts.SyntaxKind.ThisKeyword) {
    const cachedFnCtor = ctx.funcConstructorMap.get(className);
    if (cachedFnCtor) {
      const ctorFuncIdx = ctx.funcMap.get(cachedFnCtor.ctorFuncName);
      if (ctorFuncIdx !== undefined) {
        const allParamTypes = getFuncParamTypes(ctx, ctorFuncIdx);
        const paramTypes = fnctorUserParamTypes(ctx, cachedFnCtor.captureLayout, allParamTypes);
        const args = expr.arguments ?? [];
        // (fnctor-ctor-arguments.ts) Same cached-protocol reason as the
        // identifier cache-hit arm below.
        const thisReadsArguments = cachedFnCtor.readsArguments === true;
        emitFnctorConstructorArguments(
          ctx,
          fctx,
          cachedFnCtor.captureLayout,
          expr.expression,
          args,
          paramTypes,
          thisReadsArguments,
        );
        if (!thisReadsArguments)
          maybeSetArgcForKnownCall(
            ctx,
            fctx,
            cachedFnCtor.ctorFuncName,
            args.length,
            paramTypes?.length ?? args.length,
          );
        fctx.body.push({ op: "call", funcIdx: ctorFuncIdx });
        // (#2071) A widened ctor returns externref — report it, never the struct.
        return cachedFnCtor.resultIsExtern
          ? { kind: "externref" }
          : { kind: "ref", typeIdx: cachedFnCtor.structTypeIdx };
      }
    } else {
      // Build the constructor from the resolved constructor function's
      // declaration. (#2681/#2686 A1) For a `new this()` callee the type
      // `symbol` is undefined — use the owner fnctor symbol resolved above.
      const decls = (symbol ?? thisFnctorSym)?.getDeclarations();
      if (decls) {
        for (const decl of decls) {
          if (ts.isFunctionDeclaration(decl) && decl.body) {
            const result = compileNewFunctionDeclaration(ctx, fctx, expr, className, decl);
            if (result) return result;
            break;
          }
          // `var Parser = function Parser(...) {...}` (acorn): the constructor's
          // symbol resolves directly to the FunctionExpression node, or to the
          // VariableDeclaration whose initializer is one.
          if (ts.isFunctionExpression(decl) && decl.body) {
            const result = compileNewFunctionDeclaration(
              ctx,
              fctx,
              expr,
              className,
              decl as unknown as ts.FunctionDeclaration,
            );
            if (result) return result;
            break;
          }
          if (ts.isVariableDeclaration(decl) && decl.initializer) {
            let init: ts.Expression = decl.initializer;
            while (ts.isParenthesizedExpression(init)) init = init.expression;
            if (ts.isFunctionExpression(init) && init.body) {
              const result = compileNewFunctionDeclaration(
                ctx,
                fctx,
                expr,
                className,
                init as unknown as ts.FunctionDeclaration,
              );
              if (result) return result;
              break;
            }
          }
        }
      }
    }
  }

  // Check if the identifier resolves to a function declaration used as constructor
  // (e.g. `function Foo() { this.x = 1; }; new Foo()`)
  // (#3163) `calleeIdent` — the cast/paren-unwrapped identifier — so
  // `new (Foo as any)()` takes the same fnctor build path as `new Foo()`.
  if ((!className || !ctx.classSet.has(className)) && calleeIdent) {
    const fnName = calleeIdent.text;
    // Check cache first — if we already built a constructor for this function
    const cachedFnCtor = ctx.funcConstructorMap.get(fnName);
    if (cachedFnCtor) {
      const ctorFuncIdx = ctx.funcMap.get(cachedFnCtor.ctorFuncName);
      if (ctorFuncIdx !== undefined) {
        const allParamTypes = getFuncParamTypes(ctx, ctorFuncIdx);
        const paramTypes = fnctorUserParamTypes(ctx, cachedFnCtor.captureLayout, allParamTypes);
        const args = expr.arguments ?? [];
        // (fnctor-ctor-arguments.ts) The cache-hit arm never sees the
        // declaration, so the `arguments` protocol travels WITH the cached ctor.
        // Without it a second `new F(…)` dropped its over-supplied arguments
        // while the callee still expected them on `__extras_argv`.
        const cachedReadsArguments = cachedFnCtor.readsArguments === true;
        emitFnctorConstructorArguments(
          ctx,
          fctx,
          cachedFnCtor.captureLayout,
          expr.expression,
          args,
          paramTypes,
          cachedReadsArguments,
        );
        const finalIdx = ctx.funcMap.get(cachedFnCtor.ctorFuncName) ?? ctorFuncIdx;
        if (!cachedReadsArguments)
          maybeSetArgcForKnownCall(
            ctx,
            fctx,
            cachedFnCtor.ctorFuncName,
            args.length,
            paramTypes?.length ?? args.length,
          );
        fctx.body.push({ op: "call", funcIdx: finalIdx });
        // (#3138) Function-scope fnctor: call-site instance→ctor link (the
        // cached arm bypasses compileNewFunctionDeclaration's emission).
        emitCallSiteFnctorRegistration(ctx, fctx, fnName, cachedFnCtor.structTypeIdx);
        // (#2071) A widened ctor returns externref — report it, never the struct.
        return cachedFnCtor.resultIsExtern
          ? { kind: "externref" }
          : { kind: "ref", typeIdx: cachedFnCtor.structTypeIdx };
      }
    }
    // Resolve via type checker to find the function declaration
    if (!cachedFnCtor) {
      // (#3163) Resolve on the unwrapped identifier — a cast/paren node has no
      // symbol of its own.
      const exprSymbol = ctx.checker.getSymbolAtLocation(calleeIdent);
      const decls = exprSymbol?.getDeclarations();
      if (decls) {
        for (const decl of decls) {
          if (ts.isFunctionDeclaration(decl) && decl.body) {
            const result = compileNewFunctionDeclaration(ctx, fctx, expr, fnName, decl);
            if (result) return result;
            break;
          }
          // Handle `var Con = function() { this.x = 1; }; new Con()`
          // The declaration is a VariableDeclaration whose initializer is a FunctionExpression
          if (ts.isVariableDeclaration(decl) && decl.initializer) {
            let init: ts.Expression = decl.initializer;
            // Unwrap parenthesized expressions
            while (ts.isParenthesizedExpression(init)) init = init.expression;
            if (ts.isFunctionExpression(init) && init.body) {
              // Synthesize a FunctionDeclaration-like node for compileNewFunctionDeclaration
              const result = compileNewFunctionDeclaration(
                ctx,
                fctx,
                expr,
                fnName,
                init as unknown as ts.FunctionDeclaration,
              );
              if (result) return result;
              break;
            }
          }
        }
      }
    }
  }

  // (#3981) The class and fnctor arms above have declined: standalone/WASI
  // `new <function value>(...)` now constructs natively instead of evaluating
  // to null. Placed here, and not inside the `!className` block further down,
  // because the checker often DOES give the callee an inferred symbol name — a
  // JS `function F(){ this.x = 1 }` held in a `const` types `new C()` as `F`,
  // which is not in `classSet`, so control skipped every arm and the whole
  // expression fell out as `undefined`.
  if (calleeIdent && !ctx.classSet.has(calleeIdent.text) && !(className && ctx.classSet.has(className))) {
    const nativeCtor = tryCompileNativeConstructFromValue(ctx, fctx, calleeIdent, expr.arguments ?? []);
    if (nativeCtor) return nativeCtor;
  }

  // (#2608) `new this(...)` inside a function-constructor (fnctor) STATIC method
  // — e.g. acorn's `Parser.parse = function(...) { ... return new this(opts, src) }`.
  // The #1679 ThisKeyword arm above only fires when the checker resolves `this`'s
  // type symbol to a known fnctor className. For a `Fn.method = function(){…}`
  // static method the checker resolves `this` to NO symbol (className undefined),
  // so that arm is skipped and control reaches the generic dynamic-`new` path
  // below, which throws "is not a constructor" — the receiver is a wrapped
  // closure externref with no compiled `<Class>_new`. At runtime, though, `this`
  // IS correctly bound to the constructor function-value (verified `this === Fn`),
  // and that value is a WasmGC closure struct. So route it through the landed #56
  // `__construct_closure` host bridge (same machinery as the `new <localFnValue>()`
  // identifier arm above): the bridge detects `__is_closure`, wraps the closure
  // with `_wrapCallableForHost` (constructible), and `Reflect.construct`s it with
  // the args — no static fnctor resolution needed. JS-host only; standalone keeps
  // the existing throwing path (a Wasm-native dynamic Construct of `this` is a
  // separate effort). ONE terminal `flushLateImportShifts` (after the call) —
  // never mid-emission (the #608/#794 index-corruption hazard).
  if (
    expr.expression.kind === ts.SyntaxKind.ThisKeyword &&
    !noJsHost(ctx) &&
    (!className || (!ctx.classSet.has(className) && !ctx.funcConstructorMap.has(className)))
  ) {
    // Evaluate `this` to an externref value (the bound constructor function-value).
    const calleeTy = compileExpression(ctx, fctx, expr.expression, { kind: "externref" });
    if (calleeTy && calleeTy.kind !== "externref") {
      coerceType(ctx, fctx, calleeTy, { kind: "externref" });
    } else if (calleeTy === null) {
      fctx.body.push({ op: "ref.null.extern" });
    }
    const calleeLocal = allocLocal(fctx, `__nt_callee_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: calleeLocal });
    // Build a JS array of the args (boxed externref each), in source order.
    const args = expr.arguments ?? [];
    const arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
    const arrPushIdx = ensureLateImport(ctx, "__js_array_push", [{ kind: "externref" }, { kind: "externref" }], []);
    const ccIdx = ensureLateImport(
      ctx,
      "__construct_closure",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    const finalArrNew = ctx.funcMap.get("__js_array_new") ?? arrNewIdx;
    const finalArrPush = ctx.funcMap.get("__js_array_push") ?? arrPushIdx;
    const finalCc = ctx.funcMap.get("__construct_closure") ?? ccIdx;
    if (finalArrNew !== undefined && finalArrPush !== undefined && finalCc !== undefined) {
      fctx.body.push({ op: "call", funcIdx: finalArrNew });
      const argvLocal = allocLocal(fctx, `__nt_argv_${fctx.locals.length}`, { kind: "externref" });
      fctx.body.push({ op: "local.set", index: argvLocal });
      for (const arg of args) {
        fctx.body.push({ op: "local.get", index: argvLocal });
        const aTy = compileExpression(ctx, fctx, arg, { kind: "externref" });
        if (aTy && aTy.kind !== "externref") {
          coerceType(ctx, fctx, aTy, { kind: "externref" });
        } else if (aTy === null) {
          fctx.body.push({ op: "ref.null.extern" });
        }
        fctx.body.push({ op: "call", funcIdx: finalArrPush });
      }
      fctx.body.push({ op: "local.get", index: calleeLocal });
      fctx.body.push({ op: "local.get", index: argvLocal });
      fctx.body.push({ op: "call", funcIdx: finalCc });
      return { kind: "externref" };
    }
    // Imports unavailable (shouldn't happen in JS-host): fall through to the
    // existing unknown-ctor path below.
  }

  if (!className) {
    // Unknown constructor (e.g. Test262Error) — call an imported constructor
    // registered upfront by collectUnknownConstructorImports.
    const ctorName = ts.isIdentifier(expr.expression) ? expr.expression.text : "__unknown";

    // RangeError validation for built-in constructors (type resolves to any
    // when lib declarations are not loaded, so className is undefined here)
    const args = expr.arguments ?? [];

    // (#1732 S1) `new f(...)` where `f` is a LOCAL holding a builtin-method
    // value — e.g. `var f = String.prototype.indexOf; new f`. The compile-time
    // Pattern 1/2 guards above only fire on the *direct* `new X.prototype.Y()`
    // form; through a local the callee is a bare identifier of type `any`, so
    // no static guard sees it and control reaches here, which never performs
    // [[Construct]] and so wrongly does not throw (test262 String.prototype
    // `S15.5.4.*_A7` not-a-constructor cases, ~14 files in JS-host mode).
    //
    // Per ECMA-262 §7.3.13 Construct → §10.2.2 [[Construct]], `new` on a value
    // with no [[Construct]] must throw TypeError. When the local's declaration
    // initializer is a PROVABLY non-constructable expression — a
    // `<...>.prototype.<method>` member access, or a `.bind()/.call()/.apply()`
    // result — route the runtime value through the host `__construct` helper,
    // which throws a real TypeError when IsConstructor(value) is false. Builtin
    // namespaces / intrinsic ctors (ArrayBuffer, DataView, TypedArrays, Error
    // subclasses, Promise) are handled by the explicit branches that FOLLOW, so
    // this guard is scoped to the proven-non-constructor initializer shapes and
    // never intercepts a real constructor. Standalone parity is S4.
    // Unwrap `as`/paren/non-null wrappers so `new (f as any)()` is recognised
    // the same as the bare `new f` form (both reach here with the value held in
    // a local of type `any`).
    let s1Callee: ts.Expression = expr.expression;
    while (ts.isParenthesizedExpression(s1Callee) || ts.isAsExpression(s1Callee) || ts.isNonNullExpression(s1Callee)) {
      s1Callee = ts.isParenthesizedExpression(s1Callee)
        ? s1Callee.expression
        : ts.isAsExpression(s1Callee)
          ? s1Callee.expression
          : (s1Callee as ts.NonNullExpression).expression;
    }
    // (#4017) Standalone parity — see `emitStaticNotAConstructorThrow`.
    if (ts.isIdentifier(s1Callee) && noJsHost(ctx) && provablyNonConstructableStatically(ctx, s1Callee)) {
      return emitStaticNotAConstructorThrow(ctx, fctx, args);
    }

    if (ts.isIdentifier(s1Callee) && !noJsHost(ctx) && resolvesToNonConstructableValue(ctx, s1Callee)) {
      // Evaluate `f` to an externref value (the held callee), stash in a local.
      const calleeTy = compileExpression(ctx, fctx, s1Callee, { kind: "externref" });
      if (calleeTy && calleeTy.kind !== "externref") {
        coerceType(ctx, fctx, calleeTy, { kind: "externref" });
      } else if (calleeTy === null) {
        fctx.body.push({ op: "ref.null.extern" });
      }
      const calleeLocal = allocLocal(fctx, `__ctor_callee_${fctx.locals.length}`, { kind: "externref" });
      fctx.body.push({ op: "local.set", index: calleeLocal });

      // (#2745 b) Build a JS array of the call-site args. A `.bind()` result is
      // a constructable bound function when its target is a constructor, and
      // `new boundFn(...)` must apply the bound + call args (and forward
      // newTarget). The non-constructable A7 cases (arrow / prototype-method /
      // `.call`/`.apply` value) still throw at the `__construct` IsConstructor
      // check — before the args are used — so passing real args is harmless for
      // them and is the spec-correct evaluation order (args evaluated, then
      // Construct). The previous null-args path silently constructed bound
      // functions with ZERO args (test262 `15.3.4.5.2-4-*`).
      const arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
      const arrPushIdx = ensureLateImport(ctx, "__js_array_push", [{ kind: "externref" }, { kind: "externref" }], []);
      const funcIdx = ensureLateImport(
        ctx,
        "__construct",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "externref" }],
      );
      flushLateImportShifts(ctx, fctx);
      const finalArrNew = ctx.funcMap.get("__js_array_new") ?? arrNewIdx;
      const finalArrPush = ctx.funcMap.get("__js_array_push") ?? arrPushIdx;
      const finalConstruct = ctx.funcMap.get("__construct") ?? funcIdx;
      if (finalArrNew !== undefined && finalArrPush !== undefined && finalConstruct !== undefined) {
        fctx.body.push({ op: "call", funcIdx: finalArrNew });
        const argvLocal = allocLocal(fctx, `__ctor_argv_${fctx.locals.length}`, { kind: "externref" });
        fctx.body.push({ op: "local.set", index: argvLocal });
        for (const arg of args) {
          fctx.body.push({ op: "local.get", index: argvLocal });
          const aTy = compileExpression(ctx, fctx, ts.isSpreadElement(arg) ? arg.expression : arg, {
            kind: "externref",
          });
          if (aTy && aTy.kind !== "externref") {
            coerceType(ctx, fctx, aTy, { kind: "externref" });
          } else if (aTy === null) {
            fctx.body.push({ op: "ref.null.extern" });
          }
          fctx.body.push({ op: "call", funcIdx: finalArrPush });
        }
        fctx.body.push({ op: "local.get", index: calleeLocal });
        fctx.body.push({ op: "local.get", index: argvLocal });
        fctx.body.push({ op: "call", funcIdx: finalConstruct });
        return { kind: "externref" };
      }
    }

    // (#1632b-2 / #1528a residual) `new C(args)` where `C` is a runtime FUNCTION
    // VALUE bound in a local (`const C = makeCtor(); new C(42)`) — provably
    // constructable (ordinary function, not arrow/bound/method). Route through
    // the `__construct_closure` host bridge: materialize args into a JS array,
    // then `__construct_closure(callee, argv)` wraps the compiled closure with
    // `_wrapCallableForHost` (constructible) and `Reflect.construct`s it. Without
    // this the value is mis-routed to the unknown-ctor extern-class import and
    // fails at instantiation with "No dependency provided for extern class C".
    // ONE terminal `flushLateImportShifts` (after the call) — never mid-emission
    // (the PR #608/#794 index-corruption hazard). JS-host only; standalone keeps
    // the existing path (a Wasm-native dynamic Construct is a separate effort).
    if (ts.isIdentifier(s1Callee) && !noJsHost(ctx) && resolvesToConstructableFunctionValue(ctx, s1Callee)) {
      // Evaluate the callee value to externref.
      const calleeTy = compileExpression(ctx, fctx, s1Callee, { kind: "externref" });
      if (calleeTy && calleeTy.kind !== "externref") {
        coerceType(ctx, fctx, calleeTy, { kind: "externref" });
      } else if (calleeTy === null) {
        fctx.body.push({ op: "ref.null.extern" });
      }
      const calleeLocal = allocLocal(fctx, `__cc_callee_${fctx.locals.length}`, { kind: "externref" });
      fctx.body.push({ op: "local.set", index: calleeLocal });
      // Build a JS array of the args (boxed externref each), in source order.
      const arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
      const arrPushIdx = ensureLateImport(ctx, "__js_array_push", [{ kind: "externref" }, { kind: "externref" }], []);
      const ccIdx = ensureLateImport(
        ctx,
        "__construct_closure",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "externref" }],
      );
      flushLateImportShifts(ctx, fctx);
      const finalArrNew = ctx.funcMap.get("__js_array_new") ?? arrNewIdx;
      const finalArrPush = ctx.funcMap.get("__js_array_push") ?? arrPushIdx;
      const finalCc = ctx.funcMap.get("__construct_closure") ?? ccIdx;
      if (finalArrNew !== undefined && finalArrPush !== undefined && finalCc !== undefined) {
        fctx.body.push({ op: "call", funcIdx: finalArrNew });
        const argvLocal = allocLocal(fctx, `__cc_argv_${fctx.locals.length}`, { kind: "externref" });
        fctx.body.push({ op: "local.set", index: argvLocal });
        for (const arg of args) {
          fctx.body.push({ op: "local.get", index: argvLocal });
          const aTy = compileExpression(ctx, fctx, arg, { kind: "externref" });
          if (aTy && aTy.kind !== "externref") {
            coerceType(ctx, fctx, aTy, { kind: "externref" });
          } else if (aTy === null) {
            fctx.body.push({ op: "ref.null.extern" });
          }
          fctx.body.push({ op: "call", funcIdx: finalArrPush });
        }
        fctx.body.push({ op: "local.get", index: calleeLocal });
        fctx.body.push({ op: "local.get", index: argvLocal });
        fctx.body.push({ op: "call", funcIdx: finalCc });
        return { kind: "externref" };
      }
      // Imports unavailable (shouldn't happen in JS-host): fall through.
    }

    // new ArrayBuffer(byteLength) — validate non-negative integer length
    if (ctorName === "ArrayBuffer" && args.length >= 1) {
      compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
      const lenF64 = allocLocal(fctx, `__ab_len_f64_${fctx.locals.length}`, {
        kind: "f64",
      });
      fctx.body.push({ op: "local.set", index: lenF64 });
      // Check: len != floor(len) (non-integer or NaN)
      fctx.body.push({ op: "local.get", index: lenF64 });
      fctx.body.push({ op: "local.get", index: lenF64 });
      fctx.body.push({ op: "f64.floor" });
      fctx.body.push({ op: "f64.ne" });
      // Check: len < 0
      fctx.body.push({ op: "local.get", index: lenF64 });
      fctx.body.push({ op: "f64.const", value: 0 });
      fctx.body.push({ op: "f64.lt" });
      fctx.body.push({ op: "i32.or" });
      {
        const rangeErrMsg = "RangeError: Invalid array buffer length";
        addStringConstantGlobal(ctx, rangeErrMsg);
        const tagIdx = ensureExnTag(ctx);
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [...stringConstantExternrefInstrs(ctx, rangeErrMsg), { op: "throw", tagIdx }],
          else: [],
        });
      }
    }

    // new DataView(buffer, byteOffset, byteLength) — validate offset and length.
    // #1515 — apply ToIndex semantics: NaN→0, truncate toward 0, > 2^53-1 → RangeError.
    if (ctorName === "DataView") {
      // Validate byteOffset (2nd arg) if provided
      if (args.length >= 2) {
        compileExpression(ctx, fctx, args[1]!, { kind: "f64" });
        const offsetF64 = allocLocal(fctx, `__dv_offset_f64_${fctx.locals.length}`, { kind: "f64" });
        fctx.body.push({ op: "local.set", index: offsetF64 });
        // NaN → 0
        fctx.body.push({ op: "local.get", index: offsetF64 });
        fctx.body.push({ op: "local.get", index: offsetF64 });
        fctx.body.push({ op: "f64.ne" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "f64.const", value: 0 },
            { op: "local.set", index: offsetF64 },
          ],
          else: [],
        });
        fctx.body.push({ op: "local.get", index: offsetF64 });
        fctx.body.push({ op: "f64.trunc" });
        fctx.body.push({ op: "local.set", index: offsetF64 });
        // Check: offset < 0 OR offset > 2^53-1
        fctx.body.push({ op: "local.get", index: offsetF64 });
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "f64.lt" });
        fctx.body.push({ op: "local.get", index: offsetF64 });
        fctx.body.push({ op: "f64.const", value: 9007199254740991 });
        fctx.body.push({ op: "f64.gt" });
        fctx.body.push({ op: "i32.or" });
        {
          const rangeErrMsg = "RangeError: Start offset is outside the bounds of the buffer";
          addStringConstantGlobal(ctx, rangeErrMsg);
          const tagIdx = ensureExnTag(ctx);
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [...stringConstantExternrefInstrs(ctx, rangeErrMsg), { op: "throw", tagIdx }],
            else: [],
          });
        }
      }
      // Validate byteLength (3rd arg) if provided
      if (args.length >= 3) {
        compileExpression(ctx, fctx, args[2]!, { kind: "f64" });
        const lenF64 = allocLocal(fctx, `__dv_len_f64_${fctx.locals.length}`, {
          kind: "f64",
        });
        fctx.body.push({ op: "local.set", index: lenF64 });
        // NaN → 0
        fctx.body.push({ op: "local.get", index: lenF64 });
        fctx.body.push({ op: "local.get", index: lenF64 });
        fctx.body.push({ op: "f64.ne" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "f64.const", value: 0 },
            { op: "local.set", index: lenF64 },
          ],
          else: [],
        });
        fctx.body.push({ op: "local.get", index: lenF64 });
        fctx.body.push({ op: "f64.trunc" });
        fctx.body.push({ op: "local.set", index: lenF64 });
        // Check: len < 0 OR len > 2^53-1
        fctx.body.push({ op: "local.get", index: lenF64 });
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "f64.lt" });
        fctx.body.push({ op: "local.get", index: lenF64 });
        fctx.body.push({ op: "f64.const", value: 9007199254740991 });
        fctx.body.push({ op: "f64.gt" });
        fctx.body.push({ op: "i32.or" });
        {
          const rangeErrMsg = "RangeError: Invalid DataView length";
          addStringConstantGlobal(ctx, rangeErrMsg);
          const tagIdx = ensureExnTag(ctx);
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [...stringConstantExternrefInstrs(ctx, rangeErrMsg), { op: "throw", tagIdx }],
            else: [],
          });
        }
      }
    }

    // new Array(n) — validate non-negative integer length < 2^32
    if (ctorName === "Array" && args.length === 1) {
      compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
      const nF64 = allocLocal(fctx, `__arr_n_f64_${fctx.locals.length}`, {
        kind: "f64",
      });
      fctx.body.push({ op: "local.set", index: nF64 });
      // Check: n != floor(n) (non-integer or NaN)
      fctx.body.push({ op: "local.get", index: nF64 });
      fctx.body.push({ op: "local.get", index: nF64 });
      fctx.body.push({ op: "f64.floor" });
      fctx.body.push({ op: "f64.ne" });
      // Check: n < 0
      fctx.body.push({ op: "local.get", index: nF64 });
      fctx.body.push({ op: "f64.const", value: 0 });
      fctx.body.push({ op: "f64.lt" });
      fctx.body.push({ op: "i32.or" });
      // Check: n >= 2^32
      fctx.body.push({ op: "local.get", index: nF64 });
      fctx.body.push({ op: "f64.const", value: 4294967296 });
      fctx.body.push({ op: "f64.ge" });
      fctx.body.push({ op: "i32.or" });
      {
        const rangeErrMsg = "RangeError: Invalid array length";
        addStringConstantGlobal(ctx, rangeErrMsg);
        const tagIdx = ensureExnTag(ctx);
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [...stringConstantExternrefInstrs(ctx, rangeErrMsg), { op: "throw", tagIdx }],
          else: [],
        });
      }
    }

    // (#2026) Dynamic-new fallback: `new K(...)` where `K` is a value-bound
    // class identifier (type `any`) the static arms could not resolve. Dispatch
    // through the class-object descriptor's struct type to the right
    // `<Class>_new`, with a threaded argument list. Only fires for a bare
    // identifier callee (so `new (expr)()` / member-callee forms keep their
    // existing handling) and only when there is at least one struct-backed class
    // to dispatch to; otherwise falls through to the legacy `__new_` host import
    // (which still serves genuine host builtins like Test262Error).
    {
      let dynCallee: ts.Expression = expr.expression;
      while (
        ts.isParenthesizedExpression(dynCallee) ||
        ts.isAsExpression(dynCallee) ||
        ts.isNonNullExpression(dynCallee)
      ) {
        dynCallee = ts.isParenthesizedExpression(dynCallee)
          ? dynCallee.expression
          : ts.isAsExpression(dynCallee)
            ? dynCallee.expression
            : (dynCallee as ts.NonNullExpression).expression;
      }
      if (ts.isIdentifier(dynCallee) && !ctx.classSet.has(dynCallee.text)) {
        // (#3054 D) Dynamic `new <ctorVal>(buffer[, off[, len]])` where `ctorVal`
        // is a first-class `$__ta_ctor` value (a TA constructor held in a var /
        // array element — test262 `CreateRabForTest`, `for (ctor of ctors) new
        // ctor(rab, …)`). The callee is `any`, so `className` is undefined and the
        // static TA paths above are bypassed. Runtime kind-switch builds the right
        // shared-backing `$__ta_view` in the standalone lane (no host import).
        // Gated to a buffer-typed first arg so `new ctor(5)` (count ctor) is NOT
        // captured here (a boxed number would `ref.cast`-trap).
        if (noJsHost(ctx) && args.length >= 1 && !ts.isNumericLiteral(args[0]!)) {
          const arg0Sym = ctx.checker.getTypeAtLocation(args[0]!).getSymbol?.()?.name;
          if (arg0Sym === "ArrayBuffer" || arg0Sym === "SharedArrayBuffer" || arg0Sym === "DataView") {
            // Compile the ctor value once into an anyref local to type-test.
            const ctorTy = compileExpression(ctx, fctx, dynCallee, { kind: "externref" });
            if (ctorTy && ctorTy.kind !== "externref") coerceType(ctx, fctx, ctorTy, { kind: "externref" });
            else if (ctorTy === null) fctx.body.push({ op: "ref.null.extern" });
            fctx.body.push({ op: "any.convert_extern" });
            const ctorAnyLocal = allocLocal(fctx, `__dynctor_${fctx.locals.length}`, { kind: "anyref" } as ValType);
            fctx.body.push({ op: "local.set", index: ctorAnyLocal });
            const dtav = emitDynamicTaViewConstruct(ctx, fctx, ctorAnyLocal, args[0]!, args[1], args[2], (e, h) =>
              compileExpression(ctx, fctx, e, h),
            );
            if (dtav) return dtav;
          }
        }
        if (emitDynamicNewFallback(ctx, fctx, expr, dynCallee, ctorName)) {
          return { kind: "externref" };
        }
        // (#2872) Standalone/WASI class-free module: emitDynamicNewFallback
        // declined (no struct-backed class candidates), so `new TA(n)` / `new
        // TA([…])` / `new TA()` on an `any`-bound ctor previously fell through
        // to the (absent) `__new_<name>` import → `ref.null.extern`, which made
        // every `testWithTypedArrayConstructors` body read 0/undefined. Route
        // the genuinely-dynamic callee through the same runtime `$__ta_ctor`
        // construct arm the class-bearing no-match base uses; a non-TA runtime
        // value still yields null-extern (byte-identical outcome to before).
        if (
          noJsHost(ctx) &&
          resolvesToDynamicAnyCtorValue(ctx, dynCallee) &&
          !(expr.arguments ?? []).some((a) => ts.isSpreadElement(a))
        ) {
          const taCalleeTy = compileExpression(ctx, fctx, dynCallee, { kind: "externref" });
          if (taCalleeTy && taCalleeTy.kind !== "externref") {
            coerceType(ctx, fctx, taCalleeTy, { kind: "externref" });
          } else if (taCalleeTy === null) {
            fctx.body.push({ op: "ref.null.extern" });
          }
          fctx.body.push({ op: "any.convert_extern" });
          const taDescLocal = allocLocal(fctx, `__dtac_desc_${fctx.locals.length}`, { kind: "anyref" } as ValType);
          fctx.body.push({ op: "local.set", index: taDescLocal });
          const taArgLocals: number[] = [];
          for (const arg of expr.arguments ?? []) {
            const aTy = compileExpression(ctx, fctx, arg, { kind: "externref" });
            if (aTy && aTy.kind !== "externref") {
              coerceType(ctx, fctx, aTy, { kind: "externref" });
            } else if (aTy === null) {
              fctx.body.push({ op: "ref.null.extern" });
            }
            const aLocal = allocLocal(fctx, `__dtac_arg_${fctx.locals.length}`, { kind: "externref" });
            fctx.body.push({ op: "local.set", index: aLocal });
            taArgLocals.push(aLocal);
          }
          emitTaDynCtorConstructFromLocals(ctx, fctx, taDescLocal, taArgLocals);
          // (#4196) A `$__bound_fn` is not a `$__ta_ctor`, so the arm above
          // yields null for it. Retry as §10.4.1.2 [[Construct]] on null.
          emitBoundConstructOnNull(ctx, fctx, expr, taDescLocal, taArgLocals);
          // (#4438) …and a runtime-eval callable (a `Function(src)` value) is
          // neither, so it lands in the null too. Retry as §10.2.2
          // [[Construct]]. Each retry declines for the other's carrier shape,
          // so the chain has no ordering hazard.
          emitRuntimeEvalConstructOnNull(ctx, fctx, expr, taDescLocal, taArgLocals);
          return { kind: "externref" };
        }
      }
    }

    // (#3087) Dynamic `new <ctorVal>(...)` where `ctorVal` is an `any`/`unknown`-typed
    // runtime binding — most importantly a callback PARAMETER that receives a real
    // constructor at runtime, e.g. the TypedArray harness wrapper
    // `testWithTypedArrayConstructors(function (TA) { new TA(3); … })` where `TA` is the
    // concrete `Int8Array`/… ctor passed positionally into the `any`-typed callback param.
    // The compiled-class dynamic fallback above excludes externref-backed builtin ctors
    // (#2026), and the `__new_${ctorName}` host-import fallthrough below resolves to a
    // non-existent extern class → "No dependency provided for extern class 'TA'" (the
    // dominant #3074 downstream honest-fail). Route through the SAME `__construct_closure`
    // host bridge as the value-bound-function-ctor arm above: its runtime side runs the
    // spec IsConstructor probe (`Reflect.construct(function(){}, [], value)`) and either
    // `Reflect.construct`s the value or throws the spec `TypeError` for a non-constructor —
    // correct for ANY runtime value. JS-host only; standalone keeps its native TA-view
    // path (#3054) / the extern-class fallthrough. ONE terminal `flushLateImportShifts`
    // (after the call) — never mid-emission (the #608/#794 index-corruption hazard).
    if (ts.isIdentifier(s1Callee) && !noJsHost(ctx) && resolvesToDynamicAnyCtorValue(ctx, s1Callee)) {
      const calleeTy = compileExpression(ctx, fctx, s1Callee, { kind: "externref" });
      if (calleeTy && calleeTy.kind !== "externref") {
        coerceType(ctx, fctx, calleeTy, { kind: "externref" });
      } else if (calleeTy === null) {
        fctx.body.push({ op: "ref.null.extern" });
      }
      const calleeLocal = allocLocal(fctx, `__dynanyctor_callee_${fctx.locals.length}`, { kind: "externref" });
      fctx.body.push({ op: "local.set", index: calleeLocal });
      const arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
      const arrPushIdx = ensureLateImport(ctx, "__js_array_push", [{ kind: "externref" }, { kind: "externref" }], []);
      const ccIdx = ensureLateImport(
        ctx,
        "__construct_closure",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "externref" }],
      );
      flushLateImportShifts(ctx, fctx);
      const finalArrNew = ctx.funcMap.get("__js_array_new") ?? arrNewIdx;
      const finalArrPush = ctx.funcMap.get("__js_array_push") ?? arrPushIdx;
      const finalCc = ctx.funcMap.get("__construct_closure") ?? ccIdx;
      if (finalArrNew !== undefined && finalArrPush !== undefined && finalCc !== undefined) {
        fctx.body.push({ op: "call", funcIdx: finalArrNew });
        const argvLocal = allocLocal(fctx, `__dynanyctor_argv_${fctx.locals.length}`, { kind: "externref" });
        fctx.body.push({ op: "local.set", index: argvLocal });
        for (const arg of args) {
          fctx.body.push({ op: "local.get", index: argvLocal });
          const aTy = compileExpression(ctx, fctx, arg, { kind: "externref" });
          if (aTy && aTy.kind !== "externref") {
            coerceType(ctx, fctx, aTy, { kind: "externref" });
          } else if (aTy === null) {
            fctx.body.push({ op: "ref.null.extern" });
          }
          fctx.body.push({ op: "call", funcIdx: finalArrPush });
        }
        fctx.body.push({ op: "local.get", index: calleeLocal });
        fctx.body.push({ op: "local.get", index: argvLocal });
        fctx.body.push({ op: "call", funcIdx: finalCc });
        return { kind: "externref" };
      }
      // Imports unavailable (shouldn't happen in JS-host): fall through.
    }

    const importName = `__new_${ctorName}`;
    const funcIdx = ctx.funcMap.get(importName);

    if (funcIdx !== undefined) {
      // Compile arguments as externref
      for (const arg of args) {
        const resultType = compileExpression(ctx, fctx, arg, {
          kind: "externref",
        });
        if (resultType && resultType.kind !== "externref") {
          fctx.body.push({ op: "drop" });
          fctx.body.push({ op: "ref.null.extern" });
        }
      }
      // Pad missing arguments with ref.null extern (the import may have
      // more params than this particular call site provides, since the
      // import is registered with the *max* arg count across all sites).
      const importParamTypes = getFuncParamTypes(ctx, funcIdx);
      if (importParamTypes) {
        for (let i = args.length; i < importParamTypes.length; i++) {
          pushDefaultValue(fctx, importParamTypes[i]!, ctx);
        }
      }
      // Re-lookup funcIdx: argument compilation may trigger addUnionImports
      const finalNewIdx = ctx.funcMap.get(importName) ?? funcIdx;
      fctx.body.push({ op: "call", funcIdx: finalNewIdx });
    } else {
      // Fallback: no import registered (shouldn't happen), produce null
      fctx.body.push({ op: "ref.null.extern" });
    }
    return { kind: "externref" };
  }

  // Handle local class constructors
  if (ctx.classSet.has(className)) {
    const ctorName = `${className}_new`;
    const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, ctorName)); // (#1983)
    if (funcIdx === undefined) {
      reportError(ctx, expr, `Missing constructor for class: ${className}`);
      return null;
    }

    // Compile constructor arguments with type hints
    const paramTypes = getFuncParamTypes(ctx, funcIdx);
    const args = expr.arguments ?? [];
    const ctorRestInfo = ctx.funcRestParams.get(ctorName);
    let ctorActualArgCount = args.length;

    // (#2023) Save the current new.target class-id before evaluating args, so a
    // nested `new` inside an argument expression — and after this construction
    // returns — sees the correct (outer) target. Restored after the call.
    let ntPrevLocal: number | undefined;
    if (ctx.usesNewTarget && !ctx.classExternrefBackedSet.has(className)) {
      const ntGlobalIdx = ensureNewTargetGlobal(ctx);
      ntPrevLocal = allocTempLocal(fctx, { kind: "i32" });
      fctx.body.push({ op: "global.get", index: ntGlobalIdx });
      fctx.body.push({ op: "local.set", index: ntPrevLocal });
    }

    // Check for spread arguments
    const hasSpreadCtorArg = args.some((a) => ts.isSpreadElement(a));
    if (hasSpreadCtorArg && paramTypes) {
      // Flatten spread arguments for constructor call
      const flatCtorArgs = flattenCallArgs(args);
      if (flatCtorArgs) {
        ctorActualArgCount = flatCtorArgs.length;
        for (let i = 0; i < flatCtorArgs.length && i < paramTypes.length; i++) {
          compileCtorArgument(ctx, fctx, flatCtorArgs[i]!, paramTypes[i]);
        }
        for (let i = paramTypes.length; i < flatCtorArgs.length; i++) {
          evaluateCtorExtraArgument(ctx, fctx, flatCtorArgs[i]!);
        }
        // Pad missing args
        for (let i = flatCtorArgs.length; i < paramTypes.length; i++) {
          pushDefaultValue(fctx, paramTypes[i]!, ctx);
        }
      } else {
        // Non-literal spread — compile via compileSpreadCallArgs
        compileSpreadCallArgs(ctx, fctx, expr as unknown as ts.CallExpression, funcIdx, ctorRestInfo);
      }
    } else if (ctorRestInfo && !hasSpreadCtorArg) {
      // Calling a rest-param constructor: pack trailing args into a GC array
      for (let i = 0; i < ctorRestInfo.restIndex; i++) {
        if (i < args.length) {
          compileCtorArgument(ctx, fctx, args[i]!, paramTypes?.[i]);
        } else {
          pushDefaultValue(fctx, paramTypes?.[i] ?? { kind: "f64" }, ctx);
        }
      }
      // Pack remaining arguments into a vec struct (array + length)
      const restArgCount = Math.max(0, args.length - ctorRestInfo.restIndex);
      fctx.body.push({ op: "i32.const", value: restArgCount });
      for (let i = ctorRestInfo.restIndex; i < args.length; i++) {
        compileCtorArgument(ctx, fctx, args[i]!, ctorRestInfo.elemType);
      }
      fctx.body.push({
        op: "array.new_fixed",
        typeIdx: ctorRestInfo.arrayTypeIdx,
        length: restArgCount,
      });
      fctx.body.push({ op: "struct.new", typeIdx: ctorRestInfo.vecTypeIdx });
    } else {
      const positionalParamCount = paramTypes?.length ?? args.length;
      for (let i = 0; i < args.length && i < positionalParamCount; i++) {
        compileCtorArgument(ctx, fctx, args[i]!, paramTypes?.[i]);
      }
      for (let i = positionalParamCount; i < args.length; i++) {
        evaluateCtorExtraArgument(ctx, fctx, args[i]!);
      }
      // Pad missing constructor arguments with defaults (arity mismatch)
      if (paramTypes) {
        for (let i = args.length; i < paramTypes.length; i++) {
          pushDefaultValue(fctx, paramTypes[i]!, ctx);
        }
      }
    }

    // (#2023) With args on the stack, set new.target to THIS class's id right
    // before the call. The ctor body (and the super() chain it drives, which
    // calls `_init` and never touches the global) reads this id.
    if (ntPrevLocal !== undefined) {
      emitSetNewTargetBeforeCall(ctx, fctx.body, className);
    }
    // Re-lookup funcIdx: argument compilation may trigger addUnionImports
    // which shifts defined-function indices, making the earlier lookup stale.
    const finalCtorIdx = ctx.funcMap.get(classMemberFuncKey(ctx, ctorName)) ?? funcIdx; // (#1983)
    maybeSetArgcForKnownCall(ctx, fctx, ctorName, ctorActualArgCount, paramTypes?.length ?? ctorActualArgCount);
    fctx.body.push({ op: "call", funcIdx: finalCtorIdx });
    // (#1366a) Externref-backed subclass instances (extends Error / TypeError
    // / ...) bubble up as externref, NOT as (ref $struct).
    if (ctx.classExternrefBackedSet.has(className)) {
      return { kind: "externref" };
    }
    const structTypeIdx = ctx.structMap.get(className)!;
    // (#2023) Restore the saved new.target id, preserving the instance on the
    // stack across the global write.
    if (ntPrevLocal !== undefined) {
      const ntGlobalIdx = ensureNewTargetGlobal(ctx);
      const resultLocal = allocTempLocal(fctx, { kind: "ref", typeIdx: structTypeIdx });
      fctx.body.push({ op: "local.set", index: resultLocal });
      fctx.body.push({ op: "local.get", index: ntPrevLocal });
      fctx.body.push({ op: "global.set", index: ntGlobalIdx });
      fctx.body.push({ op: "local.get", index: resultLocal });
      releaseTempLocal(fctx, resultLocal);
      releaseTempLocal(fctx, ntPrevLocal);
    }
    return { kind: "ref", typeIdx: structTypeIdx };
  }

  const externInfo = ctx.externClasses.get(className);
  if (externInfo) {
    // Compile constructor arguments with type hints
    const args = expr.arguments ?? [];
    const literalIterable = args.length === 1 && ts.isArrayLiteralExpression(args[0]!) ? args[0]! : undefined;
    const pairIterableCtor = className === "Map" || className === "WeakMap";
    const flatIterableCtor = className === "Set" || className === "WeakSet";
    const canMaterializeLiteralIterable =
      literalIterable !== undefined &&
      ((flatIterableCtor &&
        !literalIterable.elements.some((entry) => ts.isOmittedExpression(entry) || ts.isSpreadElement(entry))) ||
        (pairIterableCtor &&
          literalIterable.elements.every(
            (entry) =>
              ts.isArrayLiteralExpression(entry) &&
              entry.elements.length === 2 &&
              !entry.elements.some(ts.isSpreadElement),
          )));

    if (canMaterializeLiteralIterable && literalIterable) {
      // During module initialization the host cannot call back through exported
      // `__vec_get` helpers yet: WebAssembly.instantiate has not returned the
      // instance. Build a real host array (and real [k,v] entry arrays for Map)
      // directly through the array imports instead of handing an opaque WasmGC
      // vec to the native iterable constructor.
      ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
      ensureLateImport(ctx, "__js_array_push", [{ kind: "externref" }, { kind: "externref" }], []);
      flushLateImportShifts(ctx, fctx);
      const newHostArray = (): number => {
        fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__js_array_new")! });
        const local = allocLocal(fctx, `__ctor_iter_${fctx.locals.length}`, { kind: "externref" });
        fctx.body.push({ op: "local.set", index: local });
        return local;
      };
      const pushHostValue = (arrayLocal: number, value: ts.Expression): void => {
        fctx.body.push({ op: "local.get", index: arrayLocal });
        const valueType = compileExpression(ctx, fctx, value, { kind: "externref" });
        if (valueType && valueType.kind !== "externref") coerceType(ctx, fctx, valueType, { kind: "externref" });
        if (!valueType) fctx.body.push({ op: "ref.null.extern" });
        fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__js_array_push")! });
      };

      const outer = newHostArray();
      for (const entry of literalIterable.elements) {
        if (pairIterableCtor) {
          const pair = entry as ts.ArrayLiteralExpression;
          const pairLocal = newHostArray();
          pushHostValue(pairLocal, pair.elements[0]!);
          pushHostValue(pairLocal, pair.elements[1]!);
          fctx.body.push({ op: "local.get", index: outer });
          fctx.body.push({ op: "local.get", index: pairLocal });
          fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__js_array_push")! });
        } else if (!ts.isOmittedExpression(entry) && !ts.isSpreadElement(entry)) {
          pushHostValue(outer, entry);
        }
      }
      fctx.body.push({ op: "local.get", index: outer });
    } else {
      for (let i = 0; i < args.length; i++) {
        compileExpression(ctx, fctx, args[i]!, externInfo.constructorParams[i]);
      }
    }
    // Pad missing optional args with default values
    for (let i = args.length; i < externInfo.constructorParams.length; i++) {
      pushDefaultValue(fctx, externInfo.constructorParams[i]!, ctx);
    }

    const importName = `${externInfo.importPrefix}_new`;
    const funcIdx = ctx.funcMap.get(importName);
    if (funcIdx === undefined) {
      reportError(ctx, expr, `Missing import for constructor: ${importName}`);
      return null;
    }
    fctx.body.push({ op: "call", funcIdx });
    return { kind: "externref" };
  }

  // new Uint8Array(n), new Int32Array(n), new Float64Array(n), etc. → vec struct.
  // Native Uint8Array uses i8_byte storage; the remaining typed arrays keep
  // the legacy f64 element representation.
  {
    const TYPED_ARRAY_CTORS = new Set([
      "Int8Array",
      "Uint8Array",
      "Int16Array",
      "Uint16Array",
      "Int32Array",
      "Uint32Array",
      "Float32Array",
      "Float64Array",
      // (#838) BigInt views — i64-element storage via `typedArrayVecStorage`.
      "BigInt64Array",
      "BigUint64Array",
    ]);
    // (#838 gate — fable-dev-5) BigInt views take the native i64-vec ctor path
    // only in standalone/wasi; js-host keeps the host-global BigInt64Array so
    // SharedArrayBuffer/Atomics interop works (see new-builtin-globals.ts note).
    const isBigIntCtor838 = className === "BigInt64Array" || className === "BigUint64Array";
    if (className && TYPED_ARRAY_CTORS.has(className) && (!isBigIntCtor838 || ctx.wasi || ctx.standalone)) {
      // (#2593) packed integer storage standalone/WASI — see the matching
      // count-ctor handler above. `typedArrayVecStorage` keeps host/gc on f64
      // and packs Int8/Uint8/Uint8Clamped→i8, Int16/Uint16→i16, Int32/Uint32→i32.
      const storage = typedArrayVecStorage(ctx, className);
      const elemType: ValType = storage.type;
      const elemKey = storage.key;
      const vecTypeIdx = getOrRegisterVecType(ctx, elemKey, elemType);
      const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      const args = expr.arguments ?? [];

      // (#3097) JS-host lane buffer-arg construction — see the matching gate
      // in the identifier-keyed TypedArray branch above.
      if (hostTaBufferArgSymName(ctx, args) !== undefined) {
        const hostTa = emitHostTaBufferConstruct(ctx, fctx, className, args);
        if (hostTa) return hostTa;
      }

      if (args.length === 0) {
        // new Uint8Array() → empty array
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
        fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
      } else {
        // #1654 — `new Uint8Array(arrayBuffer)` must VIEW the buffer's bytes,
        // not treat the buffer as a numeric length. The ArrayBuffer is backed
        // by an `i32_byte` vec (one i32 per byte). Detect that case and copy the
        // bytes into this TypedArray's backing vec.
        const argTsType = ctx.checker.getTypeAtLocation(args[0]!);
        const argSymName = argTsType.getSymbol?.()?.name;
        // (#3054 B1) Shared-backing `$__ta_view` (see the matching guard above).
        // Standalone/WASI only — host-mode buffers are host objects, not native
        // vecs, so the recover cast would trap (#1670).
        // B1: single buffer arg only (offset-0). Windowed `new TA(buf, off, len)`
        // is B2 — MUST match `inferTaViewType`'s `args.length === 1` gate so the
        // local's type and the constructed value agree.
        const taViewOk =
          noJsHost(ctx) &&
          args.length === 1 &&
          (argSymName === "ArrayBuffer" || argSymName === "SharedArrayBuffer" || argSymName === "DataView");
        if (taViewOk && !ts.isNumericLiteral(args[0]!)) {
          const viewResult = emitTaViewConstruct(ctx, fctx, args[0]!, className, (e, h) =>
            compileExpression(ctx, fctx, e, h),
          );
          if (viewResult) return viewResult;
        }
        // new Uint8Array(n) → array of size n, all zeros
        compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
        const sizeLocal = allocLocal(fctx, `__ta_size_${fctx.locals.length}`, {
          kind: "i32",
        });
        fctx.body.push({ op: "local.tee", index: sizeLocal });
        fctx.body.push({ op: "local.get", index: sizeLocal });
        fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
        fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
      }
      return { kind: "ref_null", typeIdx: vecTypeIdx };
    }
  }

  // new ArrayBuffer / DataView / Array — the indexed built-in constructors,
  // extracted to new-indexed.ts (#3281 slice 2). Byte-identical sentinel lift.
  {
    const r = tryCompileIndexedBuiltinNew(ctx, fctx, expr, className);
    if (r !== NEW_INDEXED_FALLTHROUGH) return r;
  }

  reportError(ctx, expr, `Unsupported new expression for class: ${className}`);
  return null;
}

export { compileClassExpression, compileNewExpression, compileSuperElementMethodCall, compileSuperMethodCall };

// #2146: resolveEnclosingClassName is now defined in shared.ts directly (no DI
// slot), so there is no longer a delegate to register here.
registerCompileSuperPropertyAccess(compileSuperPropertyAccess);
registerCompileSuperElementAccess(compileSuperElementAccess);
