import type { FieldDef, Instr, ValType } from "../../ir/types.js";
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
import { reportError } from "../context/errors.js";
import { allocLocal, allocTempLocal, getLocalType, releaseTempLocal } from "../context/locals.js";
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
  typedArrayVecStorage,
} from "../index.js";
import { coercionPlan } from "../coercion-plan.js"; // (#2934 1c) single coercion table for the copy-ctor element bridge
import {
  emitDynamicTaViewConstruct,
  emitTaViewConstruct,
  emitTaViewConstructWindowed,
  getOrRegisterDvWindowType,
} from "../dataview-native.js"; // (#2159/#38) DataView windowing wrapper; (#3054 B1/B2) shared-backing TA views + windowing; (#3054 D) dynamic ctor construct
import { emitBoundsCheckedArrayGet } from "../array-methods.js";
import { ensureMapHelpers, coerceMapKeyToAnyref } from "../map-runtime.js";
import { emitSetNewTargetBeforeCall, ensureNewTargetGlobal } from "../new-target.js"; // (#2023)
import { ensureObjectRuntime } from "../object-runtime.js"; // (#1100) standalone Proxy native runtime
import { ensureSetHelpers } from "../set-runtime.js";
import { ensureWeakCollectionHelpers } from "../weak-collections-runtime.js";
import { classMemberFuncKey } from "../class-member-keys.js"; // (#1983) collision-free class-member funcMap keys
import { compileObjectLiteralAsExternref, resolveComputedKeyExpression } from "../literals.js";
import { stringConstantExternrefInstrs, ensureAnyToStringHelper } from "../native-strings.js";
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
import { maybeSetArgcForKnownCall } from "../statements/nested-declarations.js";
import { compileStringLiteral } from "../string-ops.js";
import { coerceType as coerceTypeImpl, pushDefaultValue } from "../type-coercion.js";
import { ensureDateDaysFromCivilHelper, ensureDateStruct } from "./builtins.js";
import { emitNativeDateParse } from "../date-parse-native.js"; // (#2164) pure-Wasm new Date(str)
import { compileSpreadCallArgs } from "./extern.js";
import { compileTemporalNewExpression } from "../temporal-native.js";
import {
  emitThrowReferenceError,
  emitThrowString,
  emitThrowTypeError,
  getFuncParamTypes,
  getWasmFuncReturnType,
  isEffectivelyVoidReturn,
  noJsHost,
  wasmFuncReturnsVoid,
} from "./helpers.js";
import { localGlobalIdx } from "../registry/imports.js";
import { ensureLateImport, flushLateImportShifts } from "./late-imports.js";
import { emitFnctorProtoGet } from "./fnctor-prototype.js"; // (#2660 S3a) reconstruct `new F()` as $Object
import { emitStandalonePromiseFromExecutor } from "../promise-executor.js"; // (#2959) native new Promise(executor)
import { deriveFnctorFields, resolveFnctorSymbol, resolveEnclosingFnctorOwner } from "../fnctor-escape-gate.js"; // (#2660 S3a) canonical fnctor-name key; (#2773 S1) shared field derivation; (#2681/#2686 A1) `new this()` owner
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
function isStringTypedArg(ctx: CodegenContext, arg: ts.Expression): boolean {
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
 * (#1732 S1) Decide whether a `new <id>` callee identifier resolves to a value
 * that is PROVABLY not a constructor — so the runtime `__construct` brand check
 * can be emitted without risk of intercepting a real constructor.
 *
 * Returns true only when the identifier's (variable/parameter) declaration has
 * an initializer that is a known-non-constructable expression shape:
 *   - `<expr>.prototype.<method>` — builtin/user prototype methods never have
 *     [[Construct]] (§20.x / §10.2.2). This is the `S15.5.4.*_A7` pattern
 *     (`var f = String.prototype.indexOf; new f`).
 *   - `<expr>.bind(...)` / `.call(...)` / `.apply(...)` — bound functions are
 *     non-constructors unless the target is (and the result of `.call`/`.apply`
 *     is a plain value, never a constructor).
 *
 * Deliberately conservative: any other initializer shape (function expression,
 * class reference, plain identifier, call to a factory, etc.) returns false so
 * those keep the existing static / unknown-ctor handling. User function
 * declarations are resolved earlier (2414-2469) and never reach the caller.
 */
function resolvesToNonConstructableValue(ctx: CodegenContext, calleeExpr: ts.Expression): boolean {
  if (!ts.isIdentifier(calleeExpr)) return false;
  const sym = ctx.checker.getSymbolAtLocation(calleeExpr);
  const decls = sym?.getDeclarations();
  if (!decls || decls.length === 0) return false;

  const isNonConstructableInit = (init: ts.Expression): boolean => {
    // Unwrap as/paren/non-null wrappers.
    let e: ts.Expression = init;
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) {
      e = ts.isParenthesizedExpression(e)
        ? e.expression
        : ts.isAsExpression(e)
          ? e.expression
          : (e as ts.NonNullExpression).expression;
    }
    // (#1528a) An arrow function is PROVABLY never a constructor — §15.3.4
    // arrow functions have no [[Construct]] internal method, so `new (arrow)()`
    // must throw TypeError (§7.3.15 Construct → §7.2.4 IsConstructor). Through a
    // local of type `any` (`const f = () => 1; new f()`) no static guard sees
    // the arrow, so control reaches the unknown-ctor path and wrongly does not
    // throw; route it through the `__construct` brand check (which throws a real
    // TypeError) just like the prototype-method / bound-function shapes below.
    if (ts.isArrowFunction(e)) return true;
    // `<...>.prototype.<method>` — a method pulled off a prototype.
    if (ts.isPropertyAccessExpression(e)) {
      const obj = e.expression;
      if (ts.isPropertyAccessExpression(obj) && obj.name.text === "prototype") return true;
    }
    // `<...>.bind(...)` / `.call(...)` / `.apply(...)` result.
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
      const m = e.expression.name.text;
      if (m === "bind" || m === "call" || m === "apply") return true;
    }
    return false;
  };

  for (const decl of decls) {
    // `var/let/const f = <init>`
    if (ts.isVariableDeclaration(decl) && decl.initializer) {
      if (isNonConstructableInit(decl.initializer)) return true;
    }
  }
  return false;
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
function resolvesToConstructableFunctionValue(ctx: CodegenContext, calleeExpr: ts.Expression): boolean {
  if (!ts.isIdentifier(calleeExpr)) return false;
  if (ctx.classSet.has(calleeExpr.text) || ctx.externClasses.has(calleeExpr.text)) return false;
  // An arrow / bound / prototype-method value is non-constructable — that is the
  // throwing path, handled by resolvesToNonConstructableValue. Do not claim it.
  if (resolvesToNonConstructableValue(ctx, calleeExpr)) return false;
  const sym = ctx.checker.getSymbolAtLocation(calleeExpr);
  const decl = sym?.valueDeclaration;
  if (!decl || !ts.isVariableDeclaration(decl)) return false;
  const t = ctx.checker.getTypeAtLocation(calleeExpr);
  // Callable value (a function held in the binding). Construct-signature-bearing
  // values (real class ctors typed through the binding) are left to the static
  // class paths; here we target the ordinary-function-value cluster.
  const callSigs = t.getCallSignatures();
  if (callSigs.length === 0) return false;
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
  const kind = ctx.oracle.typeFactOf(calleeExpr).kind;
  return kind === "any" || kind === "unknown";
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
function emitHostTaBufferConstruct(
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
function hostTaBufferArgSymName(ctx: CodegenContext, args: readonly ts.Expression[]): string | undefined {
  if (noJsHost(ctx)) return undefined;
  if (args.length < 1 || args.length > 3 || ts.isNumericLiteral(args[0]!)) return undefined;
  const argSymName = ctx.oracle.builtinReceiverOf(args[0]!);
  if (argSymName === "ArrayBuffer" || argSymName === "SharedArrayBuffer") return argSymName;
  return undefined;
}

function resolvesToAmbientGlobal(ctx: CodegenContext, id: ts.Identifier): boolean {
  const sym = ctx.checker.getSymbolAtLocation(id);
  if (!sym) return true;
  const decls = sym.declarations;
  if (!decls || decls.length === 0) return true;
  return decls.every((d) => d.getSourceFile().isDeclarationFile);
}

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

function compileSuperMethodCall(ctx: CodegenContext, fctx: FunctionContext, expr: ts.CallExpression): InnerResult {
  const propAccess = expr.expression as ts.PropertyAccessExpression;
  const methodName = propAccess.name.text;

  // Determine which class we're in
  const currentClassName = resolveEnclosingClassName(fctx);
  if (!currentClassName) {
    // super.method() in object literal — evaluate args for side effects, return default
    for (const arg of expr.arguments) {
      const argType = compileExpression(ctx, fctx, arg);
      if (argType !== null) fctx.body.push({ op: "drop" });
    }
    const sig = ctx.checker.getResolvedSignature(expr);
    if (sig) {
      const retType = ctx.checker.getReturnTypeOfSignature(sig);
      const wasmType = resolveWasmType(ctx, retType);
      if (wasmType.kind === "f64") {
        fctx.body.push({ op: "f64.const", value: 0 });
      } else if (wasmType.kind === "i32") {
        fctx.body.push({ op: "i32.const", value: 0 });
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
      return wasmType;
    }
    return null;
  }

  // Find parent class
  const parentClassName = ctx.classParentMap.get(currentClassName);
  if (!parentClassName) {
    // super.method() in class without extends — no parent to resolve.
    // Evaluate args for side effects, return default value.
    for (const arg of expr.arguments) {
      const argType = compileExpression(ctx, fctx, arg);
      if (argType !== null) fctx.body.push({ op: "drop" });
    }
    const sig = ctx.checker.getResolvedSignature(expr);
    if (sig) {
      const retType = ctx.checker.getReturnTypeOfSignature(sig);
      const wasmType = resolveWasmType(ctx, retType);
      if (wasmType.kind === "f64") {
        fctx.body.push({ op: "f64.const", value: 0 });
      } else if (wasmType.kind === "i32") {
        fctx.body.push({ op: "i32.const", value: 0 });
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
      return wasmType;
    }
    return null;
  }

  // Resolve parent method — walk up the inheritance chain
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

  // Push this as first argument
  const selfIdx = fctx.localMap.get("this");
  if (selfIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: selfIdx });
  }

  // Push remaining arguments with type hints
  const paramTypes = getFuncParamTypes(ctx, funcIdx);
  // User-visible param count excludes self (param 0)
  const superParamCount = paramTypes ? paramTypes.length - 1 : expr.arguments.length;
  for (let i = 0; i < expr.arguments.length; i++) {
    if (i < superParamCount) {
      compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]); // +1 to skip self
    } else {
      // Extra argument beyond method's parameter count — evaluate for
      // side effects (JS semantics) and discard the result
      const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
      if (extraType !== null) {
        fctx.body.push({ op: "drop" });
      }
    }
  }
  // Pad missing arguments with defaults (skip self param at index 0)
  if (paramTypes) {
    for (let i = expr.arguments.length + 1; i < paramTypes.length; i++) {
      pushDefaultValue(fctx, paramTypes[i]!, ctx);
    }
  }
  // Re-lookup funcIdx: argument compilation may trigger addUnionImports
  const resolvedName = `${ancestor}_${methodName}`;
  const finalSuperIdx = ctx.funcMap.get(resolvedName) ?? funcIdx;
  maybeSetArgcForKnownCall(ctx, fctx, resolvedName, expr.arguments.length, superParamCount);
  fctx.body.push({ op: "call", funcIdx: finalSuperIdx });

  // Determine return type
  const sig = ctx.checker.getResolvedSignature(expr);
  if (sig) {
    const retType = ctx.checker.getReturnTypeOfSignature(sig);
    if (isEffectivelyVoidReturn(ctx, retType, resolvedName)) return null;
    if (wasmFuncReturnsVoid(ctx, finalSuperIdx)) return null;
    return getWasmFuncReturnType(ctx, finalSuperIdx) ?? resolveWasmType(ctx, retType);
  }
  return null;
}

/**
 * Compile `super['method'](args)` — resolve to ParentClass_method and call with this.
 * Same logic as compileSuperMethodCall but the method name comes from a computed key.
 */
function compileSuperElementMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  methodName: string,
): ValType | null {
  // Determine which class we're in
  const currentClassName = resolveEnclosingClassName(fctx);
  if (!currentClassName) {
    // super['method']() in object literal — evaluate args, return default
    for (const arg of expr.arguments) {
      const argType = compileExpression(ctx, fctx, arg);
      if (argType !== null) fctx.body.push({ op: "drop" });
    }
    return null;
  }

  // Find parent class
  const parentClassName = ctx.classParentMap.get(currentClassName);
  if (!parentClassName) {
    // super['method']() in class without extends — evaluate args, return default
    for (const arg of expr.arguments) {
      const argType = compileExpression(ctx, fctx, arg);
      if (argType !== null) fctx.body.push({ op: "drop" });
    }
    return null;
  }

  // Resolve parent method — walk up the inheritance chain
  let ancestor: string | undefined = parentClassName;
  let funcIdx: number | undefined;
  while (ancestor) {
    funcIdx = ctx.funcMap.get(`${ancestor}_${methodName}`);
    if (funcIdx !== undefined) break;
    ancestor = ctx.classParentMap.get(ancestor);
  }

  if (funcIdx === undefined) {
    // (#1614) Builtin extern-class parent — dispatch dynamically.
    const externResult = emitSuperExternMethodCall(ctx, fctx, expr, methodName, parentClassName);
    if (externResult !== null) return externResult;
    reportError(ctx, expr, `Cannot find method '${methodName}' on parent class '${parentClassName}'`);
    return null;
  }

  // Push this as first argument
  const selfIdx = fctx.localMap.get("this");
  if (selfIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: selfIdx });
  }

  // Push remaining arguments with type hints
  const paramTypes = getFuncParamTypes(ctx, funcIdx);
  // User-visible param count excludes self (param 0)
  const superElemParamCount = paramTypes ? paramTypes.length - 1 : expr.arguments.length;
  for (let i = 0; i < expr.arguments.length; i++) {
    if (i < superElemParamCount) {
      compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]); // +1 to skip self
    } else {
      // Extra argument beyond method's parameter count — evaluate for
      // side effects (JS semantics) and discard the result
      const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
      if (extraType !== null) {
        fctx.body.push({ op: "drop" });
      }
    }
  }
  // Pad missing arguments with defaults (skip self param at index 0)
  if (paramTypes) {
    for (let i = expr.arguments.length + 1; i < paramTypes.length; i++) {
      pushDefaultValue(fctx, paramTypes[i]!, ctx);
    }
  }
  // Re-lookup funcIdx: argument compilation may trigger addUnionImports
  const resolvedName = `${ancestor}_${methodName}`;
  const finalSuperIdx = ctx.funcMap.get(resolvedName) ?? funcIdx;
  maybeSetArgcForKnownCall(ctx, fctx, resolvedName, expr.arguments.length, superElemParamCount);
  fctx.body.push({ op: "call", funcIdx: finalSuperIdx });

  // Determine return type
  const sig = ctx.checker.getResolvedSignature(expr);
  if (sig) {
    const retType = ctx.checker.getReturnTypeOfSignature(sig);
    if (isEffectivelyVoidReturn(ctx, retType, resolvedName)) return null;
    if (wasmFuncReturnsVoid(ctx, finalSuperIdx)) return null;
    return getWasmFuncReturnType(ctx, finalSuperIdx) ?? resolveWasmType(ctx, retType);
  }
  return null;
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
        // Push this as argument to the getter
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
function inferArrayElementType(ctx: CodegenContext, expr: ts.NewExpression): ts.Type | null {
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
 * Check if a node tree references the `arguments` identifier.
 * Skips nested function declarations and function expressions (which have
 * their own `arguments` binding), but traverses into arrow functions
 * because arrows inherit the enclosing function's `arguments`.
 */
function usesArguments(node: ts.Node): boolean {
  if (ts.isIdentifier(node) && node.text === "arguments") return true;
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) {
    return false;
  }
  return forEachChild(node, usesArguments) ?? false;
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
 *   (b) an inline member/element receiver `new F().x` / `new F()[i]` (unwrapping
 *       `( )`/`as`/`!`): an externref receiver routes through the dynamic
 *       `__extern_get` + `$proto` walk — the resolution path we want.
 * Anything else (a struct-typed local, a module-global binding, a call argument,
 * a return, an assignment target) → false → status-quo struct lowering. The
 * conservative miss costs a row, never the floor.
 */
function fnctorNewResultConsumedAsExternref(
  _ctx: CodegenContext,
  fctx: FunctionContext,
  newExpr: ts.NewExpression,
): boolean {
  const declParent = newExpr.parent;
  if (ts.isVariableDeclaration(declParent) && declParent.initializer === newExpr && ts.isIdentifier(declParent.name)) {
    const localIdx = fctx.localMap.get(declParent.name.text);
    if (localIdx === undefined) return false; // module-global binding → status quo
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
  fctx.body.push({ op: "call", funcIdx: finalCreateIdx } as Instr);
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
function compileNewFunctionDeclaration(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.NewExpression,
  funcName: string,
  funcDecl: ts.FunctionDeclaration,
): ValType | null {
  const body = funcDecl.body;
  if (!body) return null;

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
    body.statements.length === 0 &&
    (expr.arguments?.length ?? 0) === 0 &&
    fnctorNewResultConsumedAsExternref(ctx, fctx, expr)
  ) {
    const fnctorKey = resolveFnctorSymbol(ctx.checker, expr.expression)?.name ?? funcName;
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
  const ctorParams: ValType[] = [];
  for (let i = 0; i < funcDecl.parameters.length; i++) {
    const param = funcDecl.parameters[i]!;
    const paramType = ctx.checker.getTypeAtLocation(param);
    ctorParams.push(resolveWasmType(ctx, paramType));
  }

  const ctorName = `${structName}_new`;
  const ctorResults: ValType[] = [{ kind: "ref", typeIdx: structTypeIdx }];
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
  });

  // 4. Compile the constructor body
  const paramDefs: { name: string; type: ValType }[] = [];
  for (let i = 0; i < funcDecl.parameters.length; i++) {
    const p = funcDecl.parameters[i]!;
    paramDefs.push({
      name: ts.isIdentifier(p.name) ? p.name.text : `__param${i}`,
      type: ctorParams[i] ?? { kind: "f64" },
    });
  }

  const ctorFctx: FunctionContext = {
    name: ctorName,
    params: paramDefs,
    locals: [],
    localMap: new Map(),
    returnType: { kind: "ref", typeIdx: structTypeIdx },
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };

  // Set up param locals
  for (let i = 0; i < ctorFctx.params.length; i++) {
    ctorFctx.localMap.set(ctorFctx.params[i]!.name, i);
  }

  // Allocate the struct instance with default values
  for (const field of fields) {
    if (field.type.kind === "f64") {
      ctorFctx.body.push({ op: "f64.const", value: 0 });
    } else if (field.type.kind === "i32") {
      ctorFctx.body.push({ op: "i32.const", value: 0 });
    } else if (field.type.kind === "i64") {
      ctorFctx.body.push({ op: "i64.const", value: 0n });
    } else if (field.type.kind === "externref") {
      ctorFctx.body.push({ op: "ref.null.extern" });
    } else if (field.type.kind === "ref_null") {
      ctorFctx.body.push({
        op: "ref.null",
        typeIdx: (field.type as { typeIdx: number }).typeIdx,
      } as Instr);
    } else if (field.type.kind === "ref") {
      ctorFctx.body.push({
        op: "ref.null",
        typeIdx: (field.type as { typeIdx: number }).typeIdx,
      } as Instr);
    } else {
      ctorFctx.body.push({ op: "i32.const", value: 0 });
    }
  }
  ctorFctx.body.push({ op: "struct.new", typeIdx: structTypeIdx } as Instr);

  // Store in __self local
  const selfLocal = allocLocal(ctorFctx, "__self", {
    kind: "ref",
    typeIdx: structTypeIdx,
  });
  ctorFctx.body.push({ op: "local.set", index: selfLocal });

  // Bind `this` to the struct
  ctorFctx.localMap.set("this", selfLocal);

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
  if (!ctx.standalone && !ctx.wasi) {
    const ctorGlobalIdx = ctx.moduleGlobals.get(funcName) ?? ctx.funcClosureGlobals.get(funcName);
    if (ctorGlobalIdx !== undefined) {
      ensureLateImport(ctx, "__register_fnctor_instance", [{ kind: "externref" }, { kind: "externref" }], []);
      // Apply the deferred index shift NOW (same discipline as every other
      // ensureLateImport caller in this file) so the `call` below targets the
      // import's final index instead of being re-shifted onto a neighbour.
      flushLateImportShifts(ctx, ctorFctx);
      const regIdx = ctx.funcMap.get("__register_fnctor_instance");
      if (regIdx !== undefined) {
        ctorFctx.body.push({ op: "local.get", index: selfLocal });
        ctorFctx.body.push({ op: "extern.convert_any" });
        ctorFctx.body.push({ op: "global.get", index: ctorGlobalIdx } as Instr);
        const gdef = ctx.mod.globals[localGlobalIdx(ctx, ctorGlobalIdx)];
        if (gdef && gdef.type.kind !== "externref" && gdef.type.kind !== "ref_extern") {
          ctorFctx.body.push({ op: "extern.convert_any" });
        }
        ctorFctx.body.push({ op: "call", funcIdx: regIdx });
      }
    }
  }

  // Compile the function body
  const savedFunc = ctx.currentFunc;
  if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
  if (savedFunc) ctx.funcStack.push(savedFunc);
  ctx.currentFunc = ctorFctx;
  for (const stmt of body.statements) {
    compileStatement(ctx, ctorFctx, stmt);
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

  // Return the struct instance
  ctorFctx.body.push({ op: "local.get", index: selfLocal });

  // 5. Emit the call to the constructor at the call site
  const args = expr.arguments ?? [];
  // Use the in-scope ctorParams, NOT getFuncParamTypes(ctx, ctorFuncIdx): the
  // (#1712) __register_fnctor_instance late import above opens a deferred
  // index-shift window (#329/#1899) in which ctorFuncIdx is stale-low against
  // the already-incremented numImportFuncs, so an index-based signature lookup
  // would read the PREVIOUS function's params and coerce arguments against the
  // wrong types (observed: `call[0] expected externref, found (ref null $N)`).
  const paramTypes: ValType[] | undefined = ctorParams;
  for (let i = 0; i < args.length; i++) {
    compileExpression(ctx, fctx, args[i]!, paramTypes?.[i]);
  }
  if (paramTypes) {
    for (let i = args.length; i < paramTypes.length; i++) {
      pushDefaultValue(fctx, paramTypes[i]!, ctx);
    }
  }
  // Re-lookup funcIdx in case addUnionImports shifted indices
  const finalCtorIdx = ctx.funcMap.get(classMemberFuncKey(ctx, ctorName)) ?? ctorFuncIdx; // (#1983)
  maybeSetArgcForKnownCall(ctx, fctx, ctorName, args.length, paramTypes?.length ?? args.length);
  fctx.body.push({ op: "call", funcIdx: finalCtorIdx });
  return { kind: "ref", typeIdx: structTypeIdx };
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

  const needsArguments = usesArguments(body);

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

  const liftedFuncTypeIdx = addFuncType(ctx, liftedParams, [], `${closureName}_type`);

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

  const liftedFctx: FunctionContext = {
    name: closureName,
    params: paramDefs,
    locals: [],
    localMap: new Map(),
    returnType: null,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };

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

  // Push __self argument
  fctx.body.push({ op: "local.get", index: closureLocal });

  // Push call-site arguments (flattened, spread already resolved)
  for (let i = 0; i < flatArgs.length; i++) {
    compileExpression(ctx, fctx, flatArgs[i]!, formalParams[i]);
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

  // new expression returns the constructed object — produce externref null
  // since we don't construct actual objects, and callers typically discard the result
  fctx.body.push({ op: "ref.null.extern" });
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
  // fixed-arity (`!useRuntimeArgv`) form — the dominant harness shape.
  const useConstructClosureBase = !noJsHost(ctx) && !useRuntimeArgv && resolvesToDynamicAnyCtorValue(ctx, calleeExpr);
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
  fctx.body.push({ op: "any.convert_extern" } as Instr);
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

    // Pass 1 — evaluate every spread source ONCE into a vec local (so arg
    // expressions run exactly once) and compute the argv capacity = (#non-spread
    // args) + Σ(spread source len). `vecTypeIdx` is captured per spread so we can
    // re-read its {len,data} fields without re-deriving the type.
    const spreadVecs: { local: number; vecTypeIdx: number; arrTypeIdx: number; elemType: ValType }[] = [];
    let staticCount = 0;
    fctx.body.push({ op: "i32.const", value: 0 }); // capacity accumulator on stack
    for (const arg of rawArgs) {
      if (!ts.isSpreadElement(arg)) {
        staticCount++;
        continue;
      }
      const vecTy = compileExpression(ctx, fctx, arg.expression);
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
        fctx.body.push({ op: "drop" }); // drop the capacity accumulator
        fctx.body.push({ op: "ref.null.extern" });
        return true;
      }
      const vecLocal = allocLocal(fctx, `__dynnew_svec_${fctx.locals.length}`, vecTy);
      fctx.body.push({ op: "local.tee", index: vecLocal } as Instr);
      // capacity += vec.len (vec struct field 0)
      fctx.body.push({ op: "struct.get", typeIdx: vecTy.typeIdx, fieldIdx: 0 } as Instr);
      fctx.body.push({ op: "i32.add" });
      const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTy.typeIdx);
      const arrDef = arrTypeIdx >= 0 ? ctx.mod.types[arrTypeIdx] : undefined;
      const elemType: ValType = arrDef && arrDef.kind === "array" ? arrDef.element : { kind: "f64" };
      spreadVecs.push({ local: vecLocal, vecTypeIdx: vecTy.typeIdx, arrTypeIdx, elemType });
    }
    fctx.body.push({ op: "i32.const", value: staticCount });
    fctx.body.push({ op: "i32.add" }); // total capacity
    fctx.body.push({ op: "array.new_default", typeIdx: objVecArrTypeIdx } as Instr);
    fctx.body.push({ op: "local.set", index: argvLocal });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "local.set", index: argcLocal });

    // Pass 2 — append every arg into argv in source order.
    let spreadIdx = 0;
    for (const arg of rawArgs) {
      if (!ts.isSpreadElement(arg)) {
        // argv[argc++] = box(arg)
        fctx.body.push({ op: "local.get", index: argvLocal });
        fctx.body.push({ op: "local.get", index: argcLocal });
        const aTy = compileExpression(ctx, fctx, arg, { kind: "externref" });
        if (aTy && aTy.kind !== "externref") coerceType(ctx, fctx, aTy, { kind: "externref" });
        else if (aTy === null) fctx.body.push({ op: "ref.null.extern" });
        fctx.body.push({ op: "array.set", typeIdx: objVecArrTypeIdx } as Instr);
        bumpI32Local(fctx, argcLocal);
        continue;
      }
      const sv = spreadVecs[spreadIdx++]!;
      if (sv.arrTypeIdx < 0) continue;
      // len = svec.len ; data = svec.data ; j = 0
      const jLocal = allocLocal(fctx, `__dynnew_j_${fctx.locals.length}`, { kind: "i32" });
      const lenLocal = allocLocal(fctx, `__dynnew_slen_${fctx.locals.length}`, { kind: "i32" });
      const dataLocal = allocLocal(fctx, `__dynnew_sdata_${fctx.locals.length}`, {
        kind: "ref_null",
        typeIdx: sv.arrTypeIdx,
      });
      fctx.body.push({ op: "local.get", index: sv.local });
      fctx.body.push({ op: "struct.get", typeIdx: sv.vecTypeIdx, fieldIdx: 0 } as Instr);
      fctx.body.push({ op: "local.set", index: lenLocal });
      fctx.body.push({ op: "local.get", index: sv.local });
      fctx.body.push({ op: "struct.get", typeIdx: sv.vecTypeIdx, fieldIdx: 1 } as Instr);
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
      fctx.body.push({ op: "br_if", depth: 1 } as Instr); // break outer block
      // argv[argc] = box(data[j])
      fctx.body.push({ op: "local.get", index: argvLocal });
      fctx.body.push({ op: "local.get", index: argcLocal });
      fctx.body.push({ op: "local.get", index: dataLocal });
      fctx.body.push({ op: "local.get", index: jLocal });
      emitBoundsCheckedArrayGet(fctx, sv.arrTypeIdx, sv.elemType);
      if (sv.elemType.kind !== "externref") coerceType(ctx, fctx, sv.elemType, { kind: "externref" });
      fctx.body.push({ op: "array.set", typeIdx: objVecArrTypeIdx } as Instr);
      // argc++ ; j++
      bumpI32Local(fctx, argcLocal);
      bumpI32Local(fctx, jLocal);
      fctx.body.push({ op: "br", depth: 0 } as Instr); // loop back
      fctx.body = savedBody;

      // (block (loop <loopBody>)) — loopBody breaks via `br_if 1`, repeats via `br 0`.
      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr],
      } as Instr);
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
    fctx.body.push({ op: "ref.test", typeIdx: structIdx } as Instr);
    fctx.body.push({ op: "i32.and" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: descLocal },
        { op: "ref.cast", typeIdx: structIdx } as Instr,
        { op: "struct.get", typeIdx: structIdx, fieldIdx: 0 } as Instr,
        { op: "local.set", index: tagLocal },
      ],
      else: [],
    } as Instr);
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
          { op: "array.get", typeIdx: objVecArrTypeIdx } as Instr,
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
        } as Instr);
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
      fctx.body.push({ op: "extern.convert_any" } as Instr);
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
    for (const aLocal of argLocals) {
      fctx.body.push({ op: "local.get", index: ccArgvLocal });
      fctx.body.push({ op: "local.get", index: aLocal });
      fctx.body.push({ op: "call", funcIdx: finalArrPush });
    }
    // The callee descriptor (anyref) → externref for the bridge's first param.
    fctx.body.push({ op: "local.get", index: descLocal });
    fctx.body.push({ op: "extern.convert_any" } as Instr);
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
      } as Instr,
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
  fctx.body.push({ op: "ref.as_non_null" } as Instr);
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 } as Instr);
  fctx.body.push({ op: "local.set", index: dataLocal });
  fctx.body.push({ op: "local.get", index: vecLocal });
  fctx.body.push({ op: "ref.as_non_null" } as Instr);
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 } as Instr);
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
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr],
  } as Instr);

  // Leave the collection on the stack.
  fctx.body.push({ op: "local.get", index: collTmp });
  return true;
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
  return { op, typeIdx: arrTypeIdx } as Instr;
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
  // Handle `new function() { ... }(args)` — constructor with function expression
  if (ts.isFunctionExpression(expr.expression)) {
    return compileNewFunctionExpression(ctx, fctx, expr, expr.expression);
  }

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
        if (argType !== null) fctx.body.push({ op: "drop" } as Instr);
      }
      fctx.body.push({ op: "ref.null.extern" } as Instr);
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

  // (#2162) `new WeakMap()` / `new WeakSet()` in standalone / nativeStrings mode
  // → the native weak-collection runtime, which reuses the Map backing store
  // (`__map_new` yields the same empty `$Map`). No-arg form only; the iterable
  // form falls through.
  if (
    ctx.nativeStrings &&
    ts.isIdentifier(expr.expression) &&
    (expr.expression.text === "WeakMap" || expr.expression.text === "WeakSet") &&
    (expr.arguments?.length ?? 0) === 0
  ) {
    addUnionImports(ctx);
    ensureWeakCollectionHelpers(ctx);
    const mapNewIdx = ctx.mapHelpers.get("__map_new");
    if (mapNewIdx !== undefined && ctx.mapTypeIdx >= 0) {
      fctx.body.push({ op: "call", funcIdx: mapNewIdx });
      return { kind: "ref", typeIdx: ctx.mapTypeIdx };
    }
  }

  // Arrow functions are NOT constructors — `new (() => {})` throws TypeError (#730)
  {
    const unwrappedNew = unwrapNewTarget(expr.expression);
    if (ts.isArrowFunction(unwrappedNew)) {
      // #1528: throw a real TypeError instance so `assert.throws(TypeError, …)`
      // catches it (the bare-string throw is only `instanceof Error`/string).
      emitThrowTypeError(ctx, fctx, "is not a constructor");
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }
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
      if (ts.isPropertyAccessExpression(obj) && obj.name.text === "prototype") {
        // #1528: real TypeError instance so test262 `assert.throws(TypeError, …)`
        // catches it (prototype methods are not constructors per spec §9.2.2).
        emitThrowTypeError(ctx, fctx, "is not a constructor");
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
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
          emitThrowTypeError(ctx, fctx, "is not a constructor");
          fctx.body.push({ op: "ref.null.extern" });
          return { kind: "externref" };
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
      emitThrowTypeError(ctx, fctx, "is not a constructor");
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
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

  // Handle `new Promise(executor)`.
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "Promise") {
    // (#2959) Native standalone/WASI path — construct the `$Promise` and run the
    // executor with synthesised native resolve/reject closures, retiring the
    // `Promise_new` host import. Gated inside the helper on
    // `isStandalonePromiseActive` + a resolvable executor closure; when it can't
    // apply it emits NOTHING and returns false, falling through to the host path
    // below (byte-unchanged in host/gc mode). Guard the ambient-global binding so
    // a user `class Promise {}` / local shadow keeps the normal ctor path.
    const promiseArgs = expr.arguments ?? [];
    if (
      promiseArgs.length >= 1 &&
      !ctx.classSet.has("Promise") &&
      resolvesToAmbientGlobal(ctx, expr.expression) &&
      emitStandalonePromiseFromExecutor(ctx, fctx, promiseArgs[0]!)
    ) {
      return { kind: "externref" };
    }
    let funcIdx =
      ctx.funcMap.get("Promise_new") ??
      ensureLateImport(ctx, "Promise_new", [{ kind: "externref" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
    funcIdx = ctx.funcMap.get("Promise_new") ?? funcIdx;
    if (funcIdx !== undefined) {
      const args = expr.arguments ?? [];
      if (args.length >= 1) {
        compileExpression(ctx, fctx, args[0]!, { kind: "externref" });
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
      fctx.body.push({ op: "call", funcIdx });
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    return { kind: "externref" };
  }

  // Handle `new Number(x)`, `new String(x)`, `new Boolean(x)` — wrapper constructors
  // Return externref so typeof returns "object" (wrapper semantics).
  // Number/Boolean: box to externref via __box_number. String: already externref.
  if (ts.isIdentifier(expr.expression)) {
    const ctorName = expr.expression.text;
    if (ctorName === "Number" || ctorName === "String" || ctorName === "Boolean") {
      const args = expr.arguments ?? [];

      if (ctorName === "Number") {
        // new Number(x) → create real JS Number wrapper object via __new_Number host import
        // (typeof new Number(0) === "object", not "number")
        if (args.length >= 1) {
          // ToNumber(Symbol) throws TypeError (§7.1.4) — the wrapper ctor runs
          // ToNumber on its argument before boxing. Mirror the `Number(sym)`
          // call-path guard so `new Number(Symbol())` throws too (#1564).
          if (ctx.oracle.staticJsTypeOf(args[0]!) === "symbol") {
            const t = compileExpression(ctx, fctx, args[0]!);
            if (t !== null) fctx.body.push({ op: "drop" });
            emitThrowTypeError(ctx, fctx, "Cannot convert a Symbol value to a number");
            return { kind: "externref" };
          }
          compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
        } else {
          fctx.body.push({ op: "f64.const", value: 0 });
        }
        const newNumIdx = ensureLateImport(ctx, "__new_Number", [{ kind: "f64" }], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
        const finalNumIdx = ctx.funcMap.get("__new_Number") ?? newNumIdx;
        if (finalNumIdx !== undefined) fctx.body.push({ op: "call", funcIdx: finalNumIdx });
        return { kind: "externref" };
      }

      if (ctorName === "String") {
        // new String(x) → create real JS String wrapper object via __new_String host import
        // (typeof new String("") === "object", not "string")
        if (args.length >= 1) {
          compileExpression(ctx, fctx, args[0]!, { kind: "externref" });
        } else {
          const emptyStrResult = compileStringLiteral(ctx, fctx, "");
          if (!emptyStrResult) {
            fctx.body.push({ op: "ref.null.extern" });
          }
        }
        const newStrIdx = ensureLateImport(ctx, "__new_String", [{ kind: "externref" }], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
        const finalStrIdx = ctx.funcMap.get("__new_String") ?? newStrIdx;
        if (finalStrIdx !== undefined) fctx.body.push({ op: "call", funcIdx: finalStrIdx });
        return { kind: "externref" };
      }

      if (ctorName === "Boolean") {
        // new Boolean(x) → create real JS Boolean wrapper object via __new_Boolean host import
        // (typeof new Boolean(false) === "object", not "boolean")
        if (args.length >= 1) {
          // ToBoolean never throws on Symbol (a Symbol is truthy), but this path
          // coerces the arg to f64 first, which would silently lose the Symbol.
          // A Symbol arg should produce a truthy wrapper: box 1.0.
          if (ctx.oracle.staticJsTypeOf(args[0]!) === "symbol") {
            const t = compileExpression(ctx, fctx, args[0]!);
            if (t !== null) fctx.body.push({ op: "drop" });
            fctx.body.push({ op: "f64.const", value: 1 });
          } else {
            compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
          }
        } else {
          fctx.body.push({ op: "f64.const", value: 0 });
        }
        const newBoolIdx = ensureLateImport(ctx, "__new_Boolean", [{ kind: "f64" }], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
        const finalBoolIdx = ctx.funcMap.get("__new_Boolean") ?? newBoolIdx;
        if (finalBoolIdx !== undefined) fctx.body.push({ op: "call", funcIdx: finalBoolIdx });
        return { kind: "externref" };
      }
    }
  }

  // Handle `new Error(msg)`, `new TypeError(msg)`, `new RangeError(msg)` — create real Error objects
  // via host import so .name, .message, .stack are correct and instanceof works.
  // Standalone fallback: the thrown value is just the message string (as before).
  if (ts.isIdentifier(expr.expression)) {
    const ctorName = expr.expression.text;
    if (
      ctorName === "Error" ||
      ctorName === "TypeError" ||
      ctorName === "RangeError" ||
      ctorName === "SyntaxError" ||
      ctorName === "URIError" ||
      ctorName === "EvalError" ||
      ctorName === "ReferenceError" ||
      ctorName === "Test262Error"
    ) {
      const args = expr.arguments ?? [];
      if (args.length >= 1) {
        // Compile the message argument to externref
        const resultType = compileExpression(ctx, fctx, args[0]!, {
          kind: "externref",
        });
        if (resultType && resultType.kind !== "externref") {
          coerceType(ctx, fctx, resultType, { kind: "externref" });
        }
      } else {
        // No message — push null externref (undefined message)
        fctx.body.push({ op: "ref.null.extern" });
      }
      // (#2969) §20.5.1.1 step 3 — `msg = ToString(message)` at CONSTRUCTION
      // time. In standalone/WASI the native `__new_<Name>` ctor stores its arg
      // verbatim (see error-types.ts), so `new Error(42).message` was the number
      // `42` (spec: `"42"`) and `String(new Error(42))` degraded to `"Error"`.
      // Do the ToString HERE at the user call site (null-guarded so argument-less
      // / `new Error(undefined)` still render the name alone) rather than inside
      // the SHARED ctor — the ctor is also lazily emitted for internal compiler
      // error paths (destructuring/coercion `TypeError`s), and pulling the
      // `__any_to_string` family into those emissions destabilised standalone
      // `any`-equality dispatch (the tag-5 value-eq gap deferred to #2580 M2 /
      // #3032). Host mode's `__new_<Name>` import does ToString in JS, so only
      // the native path needs this. Applies to both the WASI-error and
      // Test262Error branches below (both native, both standalone/WASI).
      if ((ctx.wasi || ctx.standalone) && args.length >= 1) {
        // Force `number_toString` before `__any_to_string` bakes so its number
        // arm renders a raw numeric message ("42") instead of degrading to
        // "[object Object]" (a module that only constructs `new Error(n)` never
        // otherwise pulls the number formatter). Must precede the ensure below.
        if (ctx.funcMap.get("number_toString") === undefined) {
          emitNativeNumberFormat(ctx, new Set(["number_toString"]));
        }
        const anyToStrIdx = ensureAnyToStringHelper(ctx);
        if (anyToStrIdx >= 0) {
          const msgTmp = allocTempLocal(fctx, { kind: "externref" });
          fctx.body.push(
            { op: "local.set", index: msgTmp },
            { op: "local.get", index: msgTmp },
            { op: "ref.is_null" },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "externref" } },
              // undefined / null argument → keep null (renders name alone).
              then: [{ op: "ref.null.extern" } as Instr],
              // ToString(message): externref → anyref → __any_to_string
              // (ref $AnyString) → externref for the ctor's $message field.
              else: [
                { op: "local.get", index: msgTmp } as Instr,
                { op: "any.convert_extern" } as Instr,
                { op: "call", funcIdx: anyToStrIdx } as Instr,
                { op: "extern.convert_any" } as Instr,
              ],
            } as Instr,
          );
          releaseTempLocal(fctx, msgTmp);
        }
      }
      // (#1104 Phase 1) In WASI/standalone mode, the JS host is unavailable —
      // use a Wasm-native `__new_<Name>` function that builds a `$Error_struct`
      // instead of a `env.__new_<Name>` host import that would leave the
      // module unsatisfiable at instantiation time. JS-host mode is unchanged.
      const importName = `__new_${ctorName}`;
      // #1473 — standalone mode also has no JS host; build the Error in-module.
      if ((ctx.wasi || ctx.standalone) && isWasiErrorName(ctorName)) {
        emitWasiErrorConstructor(ctx, ctorName, 1);
        const internalFuncIdx = ctx.funcMap.get(importName);
        if (internalFuncIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: internalFuncIdx });
        }
        return { kind: "externref" };
      }
      // (#2902) `Test262Error` is not a WASI builtin error, but the test262
      // harness declares it (`class Test262Error extends Error`) and `throw new
      // Test262Error(...)` appears in nearly every wrapped test. In standalone /
      // WASI mode the `__new_Test262Error` host import is unsatisfiable and
      // leaks the module out of host-free — yet the ctor is only reached on the
      // untaken failure path of a passing test. Build it natively as an
      // $Error_struct (tagged Error, name "Test262Error") so ~2,779 such tests
      // become host-free. JS-host mode keeps the host import (real Error).
      if ((ctx.wasi || ctx.standalone) && ctorName === "Test262Error") {
        emitStandaloneTest262Error(ctx, 1);
        const internalFuncIdx = ctx.funcMap.get(importName);
        if (internalFuncIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: internalFuncIdx });
        }
        return { kind: "externref" };
      }
      // Use host import to create a real Error object with correct .name/.message/.stack
      const funcIdx = ensureLateImport(
        ctx,
        importName,
        [{ kind: "externref" }], // message param
        [{ kind: "externref" }], // returns Error object
      );
      flushLateImportShifts(ctx, fctx);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
      }
      // If import not available (standalone), value is already on stack as externref message
      return { kind: "externref" };
    }
  }

  // Handle `new AggregateError(errors, message, options?)` (#844)
  // AggregateError takes (iterable, message, options?) — pass errors and message as externref
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "AggregateError") {
    const args = expr.arguments ?? [];
    // Compile errors argument (iterable) as externref
    if (args.length >= 1) {
      const errorsType = compileExpression(ctx, fctx, args[0]!, {
        kind: "externref",
      });
      if (errorsType && errorsType.kind !== "externref") {
        coerceType(ctx, fctx, errorsType, { kind: "externref" });
      }
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    // Compile message argument as externref
    if (args.length >= 2) {
      const msgType = compileExpression(ctx, fctx, args[1]!, {
        kind: "externref",
      });
      if (msgType && msgType.kind !== "externref") {
        coerceType(ctx, fctx, msgType, { kind: "externref" });
      }
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    // Compile options argument as externref (for cause property)
    if (args.length >= 3) {
      const optsType = compileExpression(ctx, fctx, args[2]!, {
        kind: "externref",
      });
      if (optsType && optsType.kind !== "externref") {
        coerceType(ctx, fctx, optsType, { kind: "externref" });
      }
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    const funcIdx = ensureLateImport(
      ctx,
      "__new_AggregateError",
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
    }
    return { kind: "externref" };
  }

  // Handle `new SuppressedError(error, suppressed, message, options?)` (#1634).
  // Spec §20.5.10.1: all four arguments are externref; `options.cause` is
  // installed via the dedicated `__new_SuppressedError` host import. The generic
  // 3-param extern-class path dropped `options` (no `cause`) and mishandled the
  // message coercion, so route through the dedicated import like AggregateError.
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "SuppressedError") {
    const args = expr.arguments ?? [];
    for (let i = 0; i < 4; i++) {
      if (args.length > i) {
        const t = compileExpression(ctx, fctx, args[i]!, { kind: "externref" });
        if (t && t.kind !== "externref") {
          coerceType(ctx, fctx, t, { kind: "externref" });
        }
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
    }
    const funcIdx = ensureLateImport(
      ctx,
      "__new_SuppressedError",
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
    }
    return { kind: "externref" };
  }

  // Handle `new Object()` — create an empty object (equivalent to `{}`).
  // (#1343) Previously this emitted `ref.null.extern`, but JS spec treats
  // `new Object()` as a real object: `Boolean(new Object()) === true`,
  // `(new Object()).hasOwnProperty(...) === false`, etc. Returning null
  // externref made the receiver fall through every host-import branch
  // expecting a real object, e.g. `Boolean(new Object())` returned `false`
  // because `__to_boolean(null) === 0`.
  //
  // Use `__new_plain_object` host import to produce a fresh empty object
  // with the ordinary `Object.prototype` prototype (#1525). `new Object()`
  // per §20.1.1.1 must inherit `Object.prototype` — using `__object_create(null)`
  // gave it a null prototype, so it had no `toString`/`valueOf` and any
  // ToPrimitive coercion (`==`, arithmetic, `String(...)`) threw
  // "Cannot convert object to primitive value" instead of producing
  // "[object Object]". Falls back to `ref.null.extern` only if the import
  // can't be registered.
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "Object") {
    const createIdx = ensureLateImport(ctx, "__new_plain_object", [], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
    if (createIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: createIdx });
      return { kind: "externref" };
    }
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  // Handle `new Proxy(target, handler)`.
  //
  // JS-host mode: delegate to the `__proxy_create(target, handler)` host import
  // (the host wraps the target in a real JS Proxy with the given handler).
  //
  // Standalone mode (#1100 Phase 1): there is no host Proxy, so route through the
  // Wasm-native `__proxy_create(target, handler)` emitted by `ensureObjectRuntime`
  // (object-runtime.ts `ensureProxyRuntime`). It reads the get/set/has/apply trap
  // closures off the handler object at runtime, allocates a `$Proxy` (subtype of
  // `$Object`), and the property-runtime front-guards (`__extern_get/set/has`)
  // dispatch reads/writes/has through the traps. Both modes share the same
  // `(target, handler) -> externref` signature, so the call site is uniform.
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "Proxy") {
    if (ctx.standalone) {
      const args = expr.arguments ?? [];
      // Force the object runtime (which registers the native __proxy_create +
      // the trap dispatch helpers + the front-guards) before we look up the idx.
      ensureObjectRuntime(ctx);
      const compileToExternref = (arg: ts.Expression | undefined): void => {
        if (arg === undefined) {
          fctx.body.push({ op: "ref.null.extern" });
          return;
        }
        // An OBJECT-LITERAL handler/target must lower to an OPEN `$Object`
        // (`__new_plain_object` + `__extern_set` per prop) so the runtime
        // `__proxy_create` can read the traps off the handler via `__extern_get`.
        // A closed typed struct (the default for an inline literal) hides its
        // fields from the open-object prop-map walk, so every trap reads null and
        // never fires. `compileObjectLiteralAsExternref` builds the open form —
        // the same shape a `const h: any = {…}` handler takes.
        if (ts.isObjectLiteralExpression(arg)) {
          const r = compileObjectLiteralAsExternref(ctx, fctx, arg);
          if (r === null) {
            // Builder unavailable — push undefined so the body stays valid.
            fctx.body.push({ op: "ref.null.extern" });
          }
          return;
        }
        const r = compileExpression(ctx, fctx, arg, { kind: "externref" });
        if (r && r.kind !== "externref") {
          if (r.kind === "ref" || r.kind === "ref_null") {
            fctx.body.push({ op: "extern.convert_any" });
          } else {
            coerceTypeImpl(ctx, fctx, r, { kind: "externref" });
          }
        } else if (!r) {
          // void result (shouldn't happen for a value arg) — push undefined.
          fctx.body.push({ op: "ref.null.extern" });
        }
      };
      compileToExternref(args[0]);
      compileToExternref(args[1]);
      const proxyCreateIdx = ctx.funcMap.get("__proxy_create");
      if (proxyCreateIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: proxyCreateIdx });
      } else {
        // Runtime not available (should not happen) — drop args, push undefined.
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "ref.null.extern" });
      }
      return { kind: "externref" };
    }
    const args = expr.arguments ?? [];
    if (args.length >= 1) {
      // Compile target argument and coerce to externref
      const bodyBefore = fctx.body.length;
      const targetResult = compileExpression(ctx, fctx, args[0]!);
      if (targetResult && targetResult.kind !== "externref") {
        if (targetResult.kind === "ref" || targetResult.kind === "ref_null") {
          fctx.body.push({ op: "extern.convert_any" });
        } else {
          coerceTypeImpl(ctx, fctx, targetResult, { kind: "externref" });
        }
      }

      // Compile handler argument and coerce to externref (or push null if missing)
      if (args.length >= 2) {
        const handlerResult = compileExpression(ctx, fctx, args[1]!);
        if (handlerResult && handlerResult.kind !== "externref") {
          if (handlerResult.kind === "ref" || handlerResult.kind === "ref_null") {
            fctx.body.push({ op: "extern.convert_any" });
          } else {
            coerceTypeImpl(ctx, fctx, handlerResult, { kind: "externref" });
          }
        }
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }

      // Emit call to __proxy_create(target, handler) -> externref
      const proxyIdx = ensureLateImport(
        ctx,
        "__proxy_create",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "externref" }],
      );
      flushLateImportShifts(ctx, fctx);
      if (proxyIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: proxyIdx });
      }

      return { kind: "externref" };
    }
    // No arguments — `new Proxy()`. Per §28.2.1.1 the missing target/handler
    // are `undefined`, which are not objects, so construction throws TypeError.
    // Route through __proxy_create(null, null) so the runtime raises it (#2180).
    {
      fctx.body.push({ op: "ref.null.extern" });
      fctx.body.push({ op: "ref.null.extern" });
      const proxyIdx = ensureLateImport(
        ctx,
        "__proxy_create",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "externref" }],
      );
      flushLateImportShifts(ctx, fctx);
      if (proxyIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: proxyIdx });
      }
    }
    return { kind: "externref" };
  }

  // Handle `new Function(...)`.
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "Function") {
    const args = expr.arguments ?? [];
    // (#2924) Constant param list + body → compile-away to a real AOT callable
    // (global scope, no capture). Dynamic bodies fall through to the no-op stub
    // below (the Tier-2 interpreter, #2928, handles them). Guarded on the
    // GLOBAL `Function` intrinsic (a local shadow keeps the legacy stub path).
    const staticFn = isGlobalFunctionIdentifier(expr.expression, ctx.checker)
      ? tryStaticNewFunction(ctx, fctx, args)
      : undefined;
    if (staticFn !== undefined) return staticFn;
    // (#2960) Dynamic body (non-constant args). No longer a silent no-op stub:
    //  - JS-host mode → route to the meta-circular runtime-eval shim
    //    (`__extern_eval`, global scope) so the constructed function actually
    //    works — fixes the ~119 host Function-ctor test262 cluster.
    //  - standalone/wasi (no host) → emit a source-located warning + a callable
    //    value that throws catchably at CALL time (construction still succeeds,
    //    so a program that never invokes it keeps working).
    if (isGlobalFunctionIdentifier(expr.expression, ctx.checker)) {
      const hostEval = emitDynamicNewFunctionHostEval(ctx, fctx, args);
      if (hostEval !== undefined) return hostEval;
      if (noJsHost(ctx)) {
        return emitStandaloneDynamicFunctionStub(ctx, fctx, expr, args) as ValType;
      }
    }
    // Legacy fallback (e.g. a local `Function` shadow, or JS-host with
    // nativeStrings where the shim path is unavailable): evaluate args for side
    // effects and return the historical null-value stub.
    for (const arg of args) {
      const argResult = compileExpression(ctx, fctx, arg);
      if (argResult) {
        fctx.body.push({ op: "drop" });
      }
    }
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  // Handle `new Date()`, `new Date(ms)`, `new Date(y, m, d, ...)` — native Date struct
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "Date") {
    const dateTypeIdx = ensureDateStruct(ctx);
    const args = expr.arguments ?? [];

    if (args.length === 0) {
      // (#1483) Under --target wasi, route `new Date()` (no args) to
      // clock_time_get via the __wasi_date_now helper (registered up front in
      // registerWasiImports).
      if (ctx.wasi && ctx.funcMap.has("__wasi_date_now")) {
        fctx.body.push({
          op: "call",
          funcIdx: ctx.funcMap.get("__wasi_date_now")!,
        } as Instr);
        fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
        fctx.body.push({ op: "struct.new", typeIdx: dateTypeIdx } as Instr);
        return { kind: "ref", typeIdx: dateTypeIdx };
      }
      // (#2164) Pure standalone has no wall clock — emit the Unix epoch (0)
      // directly instead of leaking the unsatisfiable env::__date_now host
      // import (which made `new Date()` a hard instantiate failure standalone,
      // breaking unrelated Date tests). See the matching Date.now() fallback in
      // expressions/calls.ts.
      if (ctx.standalone === true) {
        fctx.body.push({ op: "i64.const", value: 0n });
        fctx.body.push({ op: "struct.new", typeIdx: dateTypeIdx } as Instr);
        return { kind: "ref", typeIdx: dateTypeIdx };
      }
      const dateNowIdx = ensureLateImport(ctx, "__date_now", [], [{ kind: "f64" }]);
      if (dateNowIdx !== undefined) {
        flushLateImportShifts(ctx, fctx);
        fctx.body.push({ op: "call", funcIdx: dateNowIdx } as Instr);
        fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
      } else {
        fctx.body.push({ op: "i64.const", value: 0n });
      }
      fctx.body.push({ op: "struct.new", typeIdx: dateTypeIdx } as Instr);
      return { kind: "ref", typeIdx: dateTypeIdx };
    }

    if (args.length === 1) {
      // new Date(ms) — millisecond timestamp.
      //
      // (#1344) Detect NaN input and store a sentinel i64 so subsequent getter
      // calls (getDay, getHours, getTime, …) can return NaN per spec
      // (`new Date(NaN).getTime() → NaN`). Without this, `i64.trunc_sat_f64_s`
      // saturates NaN to 0 and the Date silently behaves like the epoch.
      //
      // (#1343) TimeClip per §21.4.1.31: if !isFinite(ms) or abs(ms) > 8.64e15,
      // return NaN. Both NaN and out-of-range get the sentinel. ±Infinity is
      // out-of-range (abs > 8.64e15), so the single magnitude check covers it.
      //
      // (#2164) new Date(str) — §21.4.2.1: a String value is parsed as if by
      // Date.parse. Route a statically-string-typed arg through the pure-Wasm
      // __date_parse helper (yields an f64 ms, NaN on failure), then fall
      // through the same TimeClip path below. Gated to standalone / WASI for the
      // same reason as Date.parse (host strings + lazy helper wiring trip the
      // late-import shift class #2043); host keeps the prior ToNumber(str)→NaN.
      if ((ctx.standalone || ctx.wasi) && isStringTypedArg(ctx, args[0]!)) {
        emitNativeDateParse(ctx);
        const argType = compileExpression(ctx, fctx, args[0]!, { kind: "externref" });
        if (argType && argType.kind !== "externref") coerceType(ctx, fctx, argType, { kind: "externref" });
        flushLateImportShifts(ctx, fctx);
        fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__date_parse")! } as Instr);
      } else if (
        !ctx.standalone &&
        !ctx.wasi &&
        isStringTypedArg(ctx, args[0]!) &&
        ctx.funcMap.has("__date_parse_host")
      ) {
        // (#2678) HOST mode: a String arg is parsed as if by Date.parse
        // (§21.4.2.1) — delegate to the JS `Date.parse` host import (registered
        // up-front by collectDateParseHostImports, no #2043 late-import shift).
        const argType = compileExpression(ctx, fctx, args[0]!, { kind: "externref" });
        if (argType && argType.kind !== "externref") coerceType(ctx, fctx, argType, { kind: "externref" });
        fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__date_parse_host")! } as Instr);
      } else {
        compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
      }
      const msLocal = allocTempLocal(fctx, { kind: "f64" });
      fctx.body.push({ op: "local.tee", index: msLocal } as Instr);
      // isInvalid = (ms != ms) || (abs(ms) > 8.64e15)
      // ms != ms is true iff ms is NaN (covers NaN)
      fctx.body.push({ op: "local.get", index: msLocal } as Instr);
      fctx.body.push({ op: "f64.ne" } as Instr);
      fctx.body.push({ op: "local.get", index: msLocal } as Instr);
      fctx.body.push({ op: "f64.abs" } as Instr);
      fctx.body.push({ op: "f64.const", value: 8.64e15 } as Instr);
      fctx.body.push({ op: "f64.gt" } as Instr);
      fctx.body.push({ op: "i32.or" } as Instr);
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "i64" } },
        then: [{ op: "i64.const", value: -9223372036854775808n }],
        else: [{ op: "local.get", index: msLocal } as Instr, { op: "i64.trunc_sat_f64_s" } as Instr],
      });
      releaseTempLocal(fctx, msLocal);
      fctx.body.push({ op: "struct.new", typeIdx: dateTypeIdx } as Instr);
      return { kind: "ref", typeIdx: dateTypeIdx };
    }

    // new Date(year, month, day?, hours?, minutes?, seconds?, ms?)
    // JS months are 0-indexed. Day defaults to 1, rest default to 0.
    {
      const daysFromCivilIdx = ensureDateDaysFromCivilHelper(ctx);

      // (#1343) Track whether any arg is NaN or non-finite. If so, the resulting
      // Date is Invalid (§21.4.2.1 MakeDate / TimeClip step on non-finite).
      // We OR-accumulate an i32 flag and stash the f64 value before trunc.
      const nonFiniteLocal = allocTempLocal(fctx, { kind: "i32" });
      fctx.body.push({ op: "i32.const", value: 0 } as Instr);
      fctx.body.push({ op: "local.set", index: nonFiniteLocal } as Instr);

      const checkNonFinite = (f64Local: number) => {
        // flag = flag | (v != v) | (abs(v) == +Inf)
        // We treat ±Inf as "non-finite enough" too — abs(v) > 8.64e15 is sufficient.
        fctx.body.push({ op: "local.get", index: nonFiniteLocal } as Instr);
        fctx.body.push({ op: "local.get", index: f64Local } as Instr);
        fctx.body.push({ op: "local.get", index: f64Local } as Instr);
        fctx.body.push({ op: "f64.ne" } as Instr); // NaN check
        fctx.body.push({ op: "i32.or" } as Instr);
        fctx.body.push({ op: "local.get", index: f64Local } as Instr);
        fctx.body.push({ op: "f64.abs" } as Instr);
        fctx.body.push({ op: "f64.const", value: 8.64e15 } as Instr);
        fctx.body.push({ op: "f64.gt" } as Instr);
        fctx.body.push({ op: "i32.or" } as Instr);
        fctx.body.push({ op: "local.set", index: nonFiniteLocal } as Instr);
      };

      // Compile year
      compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
      const yearF64Local = allocTempLocal(fctx, { kind: "f64" });
      fctx.body.push({ op: "local.tee", index: yearF64Local } as Instr);
      checkNonFinite(yearF64Local);
      fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
      const yearLocal = allocTempLocal(fctx, { kind: "i64" });
      fctx.body.push({ op: "local.set", index: yearLocal } as Instr);
      releaseTempLocal(fctx, yearF64Local);

      // Compile month (0-indexed) + 1 for civil algorithm
      compileExpression(ctx, fctx, args[1]!, { kind: "f64" });
      const monthF64Local = allocTempLocal(fctx, { kind: "f64" });
      fctx.body.push({ op: "local.tee", index: monthF64Local } as Instr);
      checkNonFinite(monthF64Local);
      releaseTempLocal(fctx, monthF64Local);
      fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
      fctx.body.push({ op: "i64.const", value: 1n } as Instr);
      fctx.body.push({ op: "i64.add" } as Instr);
      const monthLocal = allocTempLocal(fctx, { kind: "i64" });
      fctx.body.push({ op: "local.set", index: monthLocal } as Instr);

      // (#1343) For the remaining optional args, also accumulate the non-finite
      // flag when the arg is present.
      const compileTimePart = (argIdx: number, defaultI64: bigint, localKind: ValType) => {
        if (args.length > argIdx) {
          compileExpression(ctx, fctx, args[argIdx]!, { kind: "f64" });
          const f64L = allocTempLocal(fctx, { kind: "f64" });
          fctx.body.push({ op: "local.tee", index: f64L } as Instr);
          checkNonFinite(f64L);
          releaseTempLocal(fctx, f64L);
          fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
        } else {
          fctx.body.push({ op: "i64.const", value: defaultI64 } as Instr);
        }
        const local = allocTempLocal(fctx, localKind);
        fctx.body.push({ op: "local.set", index: local } as Instr);
        return local;
      };

      const dayLocal = compileTimePart(2, 1n, { kind: "i64" });
      const hoursLocal = compileTimePart(3, 0n, { kind: "i64" });
      const minutesLocal = compileTimePart(4, 0n, { kind: "i64" });
      const secondsLocal = compileTimePart(5, 0n, { kind: "i64" });
      const msLocal = compileTimePart(6, 0n, { kind: "i64" });

      // Handle year 0-99 mapping to 1900-1999 (JS Date quirk)
      // if (0 <= year <= 99) year += 1900
      fctx.body.push(
        { op: "local.get", index: yearLocal } as Instr,
        { op: "i64.const", value: 0n } as Instr,
        { op: "i64.ge_s" } as Instr,
        { op: "local.get", index: yearLocal } as Instr,
        { op: "i64.const", value: 99n } as Instr,
        { op: "i64.le_s" } as Instr,
        { op: "i32.and" } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: yearLocal } as Instr,
            { op: "i64.const", value: 1900n } as Instr,
            { op: "i64.add" } as Instr,
            { op: "local.set", index: yearLocal } as Instr,
          ],
        },
      );

      // Call days_from_civil(year, month, day) → i64 days
      fctx.body.push(
        { op: "local.get", index: yearLocal } as Instr,
        { op: "local.get", index: monthLocal } as Instr,
        { op: "local.get", index: dayLocal } as Instr,
        { op: "call", funcIdx: daysFromCivilIdx } as Instr,
      );

      // timestamp = days * 86400000 + hours * 3600000 + minutes * 60000 + seconds * 1000 + ms
      fctx.body.push(
        { op: "i64.const", value: 86400000n } as Instr,
        { op: "i64.mul" } as Instr,
        { op: "local.get", index: hoursLocal } as Instr,
        { op: "i64.const", value: 3600000n } as Instr,
        { op: "i64.mul" } as Instr,
        { op: "i64.add" } as Instr,
        { op: "local.get", index: minutesLocal } as Instr,
        { op: "i64.const", value: 60000n } as Instr,
        { op: "i64.mul" } as Instr,
        { op: "i64.add" } as Instr,
        { op: "local.get", index: secondsLocal } as Instr,
        { op: "i64.const", value: 1000n } as Instr,
        { op: "i64.mul" } as Instr,
        { op: "i64.add" } as Instr,
        { op: "local.get", index: msLocal } as Instr,
        { op: "i64.add" } as Instr,
      );

      // (#1343) TimeClip §21.4.1.31: if any arg was NaN/non-finite, or
      // abs(ts) > 8.64e15, the time is invalid. The nonFiniteLocal flag covers
      // the f64 NaN/Inf cases (i64.trunc_sat_f64_s would otherwise saturate them
      // silently); the magnitude check covers in-range f64 values that still
      // produce an out-of-range timestamp.
      const tsResultLocal = allocTempLocal(fctx, { kind: "i64" });
      fctx.body.push({ op: "local.set", index: tsResultLocal } as Instr);
      fctx.body.push(
        { op: "local.get", index: nonFiniteLocal } as Instr,
        { op: "local.get", index: tsResultLocal } as Instr,
        { op: "f64.convert_i64_s" } as Instr,
        { op: "f64.abs" } as Instr,
        { op: "f64.const", value: 8.64e15 } as Instr,
        { op: "f64.gt" } as Instr,
        { op: "i32.or" } as Instr,
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i64" } },
          then: [{ op: "i64.const", value: -9223372036854775808n } as Instr],
          else: [{ op: "local.get", index: tsResultLocal } as Instr],
        },
      );
      releaseTempLocal(fctx, tsResultLocal);
      releaseTempLocal(fctx, nonFiniteLocal);

      fctx.body.push({ op: "struct.new", typeIdx: dateTypeIdx } as Instr);

      releaseTempLocal(fctx, msLocal);
      releaseTempLocal(fctx, secondsLocal);
      releaseTempLocal(fctx, minutesLocal);
      releaseTempLocal(fctx, hoursLocal);
      releaseTempLocal(fctx, dayLocal);
      releaseTempLocal(fctx, monthLocal);
      releaseTempLocal(fctx, yearLocal);

      return { kind: "ref", typeIdx: dateTypeIdx };
    }
  }

  // Handle `new TypedArray(n)` — TypedArray constructors (Uint8Array, Int32Array, Float64Array, etc.)
  // TypedArrays are fixed-length numeric arrays. Native Uint8Array uses the
  // byte-oriented i8_byte vec; other typed arrays stay on the legacy f64
  // representation for now.
  if (ts.isIdentifier(expr.expression)) {
    const TYPED_ARRAY_NAMES = new Set([
      "Int8Array",
      "Uint8Array",
      "Uint8ClampedArray",
      "Int16Array",
      "Uint16Array",
      "Int32Array",
      "Uint32Array",
      "Float32Array",
      "Float64Array",
    ]);
    if (TYPED_ARRAY_NAMES.has(expr.expression.text)) {
      // (#2593) Standalone/WASI packs integer views into i8/i16/i32 storage
      // (Int8/Uint8/Uint8Clamped→i8_byte, Int16/Uint16→i16_byte,
      // Int32/Uint32→i32_byte); host/gc and the float views keep f64.
      // `typedArrayVecStorage` is the single source of truth so the
      // count-constructor's backing vec matches the read / byteLength paths.
      // Before #2593 only native Uint8Array packed (everything else f64), which
      // left `new Int32Array(n)` on an f64 vec while the byteLength reader cast
      // to i32_byte — a runtime type mismatch (read 0 / illegal cast).
      const storage = typedArrayVecStorage(ctx, expr.expression.text);
      const elemWasm: ValType = storage.type;
      const elemKey = storage.key;
      const vecTypeIdx = getOrRegisterVecType(ctx, elemKey, elemWasm);
      const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      const args = expr.arguments ?? [];

      // (#3097) JS-host lane `new <TA>(buffer[, byteOffset[, length]])`:
      // route through the host construct bridge (real host TypedArray view
      // over the canonical host ArrayBuffer) instead of the numeric-length
      // fallback below, which coerced the buffer struct to NaN → a length-0
      // vec. Standalone keeps the native `$__ta_view` paths (B1/B2 below).
      if (hostTaBufferArgSymName(ctx, args) !== undefined) {
        const hostTa = emitHostTaBufferConstruct(ctx, fctx, expr.expression.text, args);
        if (hostTa) return hostTa;
      }

      if (args.length === 0) {
        // new TypedArray() → empty array, length 0
        fctx.body.push({ op: "i32.const", value: 0 }); // length = 0
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
        fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
        return { kind: "ref_null", typeIdx: vecTypeIdx };
      }

      if (args.length === 1) {
        // Check if argument is a numeric literal or expression (size constructor)
        // vs an array/iterable (copy constructor)
        const argType = ctx.checker.getTypeAtLocation(args[0]!);
        const argSym = argType.getSymbol?.();
        // #1654 — `new Uint8Array(arrayBuffer)` views the buffer's bytes. The
        // ArrayBuffer/DataView is backed by an i32_byte vec; copy the bytes
        // into this TypedArray's backing array. Must precede the
        // size-constructor path (an ArrayBuffer is NOT a numeric length).
        //
        // #1670 — only in no-JS-host mode. The byte-buffer view path emits an
        // unconditional `ref.cast` to the native `i32_byte` vec. In JS-host
        // mode an ArrayBuffer / SharedArrayBuffer is NOT lowered to that vec
        // (e.g. `new SharedArrayBuffer(n)` has no native struct), so the cast
        // traps with `illegal cast` before any spec validation runs — this
        // regressed 28 Atomics negative tests built on
        // `new Int32Array(new SharedArrayBuffer(...))`. Host mode already
        // handles the buffer arg correctly via the runtime, so skip the
        // native view path there.
        const argSymName = argSym?.name;
        // (#3054 B1) Build a SHARED-BACKING `$__ta_view` that refs the buffer's
        // vec (not a copy) so sibling views / DataViews observe writes. Gated on
        // `noJsHost` (standalone/WASI): the native `i32_byte` vec representation
        // of ArrayBuffer/DataView only exists in the host-free lane. In JS-host
        // mode an ArrayBuffer is a host object (no native vec), so the recover
        // `any.convert_extern` + `ref.cast` would trap — host mode routes buffers
        // through the runtime instead (#1670). This replaces the former copy loop
        // (`emitTypedArrayFromByteBuffer`) that CLONED the bytes into a fresh
        // backing array, which broke sibling/DataView observability.
        const taViewOk =
          noJsHost(ctx) &&
          (argSymName === "ArrayBuffer" || argSymName === "SharedArrayBuffer" || argSymName === "DataView");
        if (taViewOk && !ts.isNumericLiteral(args[0]!)) {
          const viewResult = emitTaViewConstruct(ctx, fctx, args[0]!, expr.expression.text, (e, h) =>
            compileExpression(ctx, fctx, e, h),
          );
          if (viewResult) return viewResult;
        }
        const isArrayLike =
          argSym?.name === "Array" ||
          ((argType.flags & ts.TypeFlags.Object) !== 0 &&
            argSym?.name !== undefined &&
            TYPED_ARRAY_NAMES.has(argSym.name));

        if (!isArrayLike || ts.isNumericLiteral(args[0]!)) {
          // new TypedArray(n) → fixed-size array of length n, all zeros
          compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
          fctx.body.push({ op: "i32.trunc_sat_f64_s" });
          const sizeLocal = allocLocal(fctx, `__ta_size_${fctx.locals.length}`, { kind: "i32" });
          fctx.body.push({ op: "local.tee", index: sizeLocal }); // length = n
          fctx.body.push({ op: "local.get", index: sizeLocal });
          fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
          fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
          return { kind: "ref_null", typeIdx: vecTypeIdx };
        }

        // new TypedArray(arrayLike) — copy from source array
        // Compile source, then copy elements
        const srcResult = compileExpression(ctx, fctx, args[0]!);
        if (srcResult && (srcResult.kind === "ref" || srcResult.kind === "ref_null")) {
          const srcTypeIdx = (srcResult as { typeIdx: number }).typeIdx;
          const srcTypeDef = ctx.mod.types[srcTypeIdx];
          // Check if source is a vec struct
          if (
            srcTypeDef?.kind === "struct" &&
            srcTypeDef.fields[0]?.name === "length" &&
            srcTypeDef.fields[1]?.name === "data"
          ) {
            const srcVecLocal = allocLocal(fctx, `__ta_src_${fctx.locals.length}`, srcResult);
            fctx.body.push({ op: "local.set", index: srcVecLocal });
            // Get source length
            fctx.body.push({ op: "local.get", index: srcVecLocal });
            fctx.body.push({
              op: "struct.get",
              typeIdx: srcTypeIdx,
              fieldIdx: 0,
            });
            const lenLocal = allocLocal(fctx, `__ta_len_${fctx.locals.length}`, { kind: "i32" });
            fctx.body.push({ op: "local.tee", index: lenLocal });
            // Create new array of that length
            fctx.body.push({ op: "local.get", index: lenLocal });
            fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
            const dstDataLocal = allocLocal(fctx, `__ta_dst_${fctx.locals.length}`, {
              kind: "ref",
              typeIdx: arrTypeIdx,
            });
            fctx.body.push({ op: "local.set", index: dstDataLocal });

            // If source and dest have the same array type, use array.copy
            const srcArrTypeIdx = getArrTypeIdxFromVec(ctx, srcTypeIdx);
            if (srcArrTypeIdx === arrTypeIdx) {
              fctx.body.push({ op: "local.get", index: dstDataLocal });
              fctx.body.push({ op: "i32.const", value: 0 });
              fctx.body.push({ op: "local.get", index: srcVecLocal });
              fctx.body.push({
                op: "struct.get",
                typeIdx: srcTypeIdx,
                fieldIdx: 1,
              });
              fctx.body.push({ op: "i32.const", value: 0 });
              fctx.body.push({ op: "local.get", index: lenLocal });
              fctx.body.push({
                op: "array.copy",
                dstTypeIdx: arrTypeIdx,
                srcTypeIdx: arrTypeIdx,
              } as Instr);
            } else if (srcArrTypeIdx >= 0) {
              const srcArrDef = ctx.mod.types[srcArrTypeIdx];
              const dstArrDef = ctx.mod.types[arrTypeIdx];
              if (srcArrDef?.kind === "array" && dstArrDef?.kind === "array") {
                const srcDataLocal = allocLocal(fctx, `__ta_src_data_${fctx.locals.length}`, {
                  kind: "ref",
                  typeIdx: srcArrTypeIdx,
                });
                const copyIndexLocal = allocLocal(fctx, `__ta_copy_i_${fctx.locals.length}`, { kind: "i32" });
                fctx.body.push({ op: "local.get", index: srcVecLocal });
                fctx.body.push({ op: "struct.get", typeIdx: srcTypeIdx, fieldIdx: 1 });
                fctx.body.push({ op: "local.set", index: srcDataLocal });
                fctx.body.push({ op: "i32.const", value: 0 });
                fctx.body.push({ op: "local.set", index: copyIndexLocal });

                const srcGetOp =
                  srcArrDef.element.kind === "i8"
                    ? "array.get_u"
                    : srcArrDef.element.kind === "i16"
                      ? "array.get_s"
                      : "array.get";
                // (#2934 1c) The element-conversion matrix keys on the READ
                // value's stack kind (packed i8/i16 widen to i32 via get_u/_s).
                // The old matrix only knew f64↔int, so an EXTERNREF source
                // element (`new Uint8Array([102])` where the literal compiled
                // to an any[] externref vec) flowed uncoerced into the packed
                // `array.set` — "array.set[2] expected i32, found array.get of
                // externref" (the toBase64/`__cb_0` invalid-Wasm cluster). An
                // externref element now unboxes (ToNumber) and truncates to
                // integer storage; packed stores truncate width for free.
                const srcReadKind =
                  srcArrDef.element.kind === "i8" || srcArrDef.element.kind === "i16" ? "i32" : srcArrDef.element.kind;
                const dstStoreKind =
                  dstArrDef.element.kind === "i8" || dstArrDef.element.kind === "i16" ? "i32" : dstArrDef.element.kind;
                let convertInstrs: Instr[];
                if (srcReadKind === "externref" && dstStoreKind !== "externref") {
                  // ToNumber the boxed element via the single coercion table
                  // (#2108 — coercionPlan's externref→i32 row is exactly
                  // unbox + trunc_sat; externref→f64 is the bare unbox).
                  // Integer storage then truncates width on the packed store.
                  addUnionImports(ctx);
                  const plan = coercionPlan(
                    { kind: "externref" },
                    { kind: dstStoreKind === "f64" ? "f64" : "i32" },
                    {
                      boxNumberIdx: ctx.funcMap.get("__box_number") ?? null,
                      unboxNumberIdx: ctx.funcMap.get("__unbox_number") ?? null,
                    },
                  );
                  convertInstrs = plan?.instrs ?? [];
                } else if (srcReadKind === "f64" && dstStoreKind !== "f64" && dstStoreKind !== "externref") {
                  convertInstrs = [{ op: "i32.trunc_sat_f64_s" } as Instr];
                } else if (srcReadKind !== "f64" && srcReadKind !== "externref" && dstStoreKind === "f64") {
                  convertInstrs = [{ op: "f64.convert_i32_u" } as Instr];
                } else {
                  convertInstrs = [];
                }

                fctx.body.push({
                  op: "block",
                  blockType: { kind: "empty" },
                  body: [
                    {
                      op: "loop",
                      blockType: { kind: "empty" },
                      body: [
                        { op: "local.get", index: copyIndexLocal } as Instr,
                        { op: "local.get", index: lenLocal } as Instr,
                        { op: "i32.ge_u" } as Instr,
                        { op: "br_if", depth: 1 } as Instr,
                        { op: "local.get", index: dstDataLocal } as Instr,
                        { op: "local.get", index: copyIndexLocal } as Instr,
                        { op: "local.get", index: srcDataLocal } as Instr,
                        { op: "local.get", index: copyIndexLocal } as Instr,
                        { op: srcGetOp, typeIdx: srcArrTypeIdx } as Instr,
                        ...convertInstrs,
                        { op: "array.set", typeIdx: arrTypeIdx } as Instr,
                        { op: "local.get", index: copyIndexLocal } as Instr,
                        { op: "i32.const", value: 1 } as Instr,
                        { op: "i32.add" } as Instr,
                        { op: "local.set", index: copyIndexLocal } as Instr,
                        { op: "br", depth: 0 } as Instr,
                      ],
                    } as Instr,
                  ],
                } as Instr);
              }
            }
            // Build result vec struct
            fctx.body.push({ op: "local.get", index: lenLocal });
            fctx.body.push({ op: "local.get", index: dstDataLocal });
            fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
            return { kind: "ref_null", typeIdx: vecTypeIdx };
          }
        }
        // Fallback: treat argument as length
        // (source was already compiled and is on stack — drop it and recompile as f64)
        if (srcResult) fctx.body.push({ op: "drop" });
        compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
        const fallbackSize = allocLocal(fctx, `__ta_fsz_${fctx.locals.length}`, { kind: "i32" });
        fctx.body.push({ op: "local.tee", index: fallbackSize });
        fctx.body.push({ op: "local.get", index: fallbackSize });
        fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
        fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
        return { kind: "ref_null", typeIdx: vecTypeIdx };
      }

      // (#3054 B2) `new <TA>(buffer, byteOffset[, length])` — windowed
      // shared-backing view. Build a `$__ta_view` with the byteOffset field
      // populated (B1 pinned it 0) so `a[i]` addresses `byteOffset + i*width`
      // into the SHARED buffer (sibling/DataView windows mutually observable).
      // Standalone/WASI only — host-mode buffers are host objects, not native
      // vecs (#1670). MUST match `inferTaViewType`'s multi-arg gate so the
      // local's type and the constructed value agree.
      if (noJsHost(ctx) && args.length >= 2 && !ts.isNumericLiteral(args[0]!)) {
        // (#1930) Query the type-oracle boundary, not the raw checker — this
        // also keeps the gate in lock-step with `inferTaViewType` (variables.ts),
        // which resolves the buffer arg through the same oracle.
        const winArgSymName = ctx.oracle.builtinReceiverOf(args[0]!);
        if (winArgSymName === "ArrayBuffer" || winArgSymName === "SharedArrayBuffer" || winArgSymName === "DataView") {
          const winResult = emitTaViewConstructWindowed(
            ctx,
            fctx,
            args[0]!,
            args[1]!,
            args[2],
            expr.expression.text,
            (e, h) => compileExpression(ctx, fctx, e, h),
          );
          if (winResult) return winResult;
        }
      }

      // new TypedArray() with multiple args — shouldn't happen per spec, but handle gracefully
      // Treat like new TypedArray(0)
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
      fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
      return { kind: "ref_null", typeIdx: vecTypeIdx };
    }
  }

  const type = ctx.checker.getTypeAtLocation(expr);
  const symbol = type.getSymbol();
  let className = symbol?.name;
  // (#2681/#2686 A1) The fnctor symbol for a `new this()` callee, resolved from
  // the enclosing method's owner fnctor (the type symbol of `new this()` is
  // `any`/none, so `symbol` is undefined). Used by the #1679 build path below.
  let thisFnctorSym: ts.Symbol | undefined;

  // For class expressions (const C = class { ... }), the symbol name may be
  // the internal anonymous name (e.g. "__class"). Look up the mapped name first,
  // then fall back to the identifier used in the new expression.
  if (className && !ctx.classSet.has(className)) {
    const mapped = ctx.classExprNameMap.get(className);
    if (mapped) {
      className = mapped;
    }
  }
  if ((!className || !ctx.classSet.has(className)) && ts.isIdentifier(expr.expression)) {
    const idName = expr.expression.text;
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
    ctx.standalone &&
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
        const paramTypes = getFuncParamTypes(ctx, ctorFuncIdx);
        const args = expr.arguments ?? [];
        for (let i = 0; i < args.length; i++) {
          compileExpression(ctx, fctx, args[i]!, paramTypes?.[i]);
        }
        if (paramTypes) {
          for (let i = args.length; i < paramTypes.length; i++) {
            pushDefaultValue(fctx, paramTypes[i]!, ctx);
          }
        }
        maybeSetArgcForKnownCall(ctx, fctx, cachedFnCtor.ctorFuncName, args.length, paramTypes?.length ?? args.length);
        fctx.body.push({ op: "call", funcIdx: ctorFuncIdx });
        return { kind: "ref", typeIdx: cachedFnCtor.structTypeIdx };
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
  if ((!className || !ctx.classSet.has(className)) && ts.isIdentifier(expr.expression)) {
    const fnName = expr.expression.text;
    // Check cache first — if we already built a constructor for this function
    const cachedFnCtor = ctx.funcConstructorMap.get(fnName);
    if (cachedFnCtor) {
      const ctorFuncIdx = ctx.funcMap.get(cachedFnCtor.ctorFuncName);
      if (ctorFuncIdx !== undefined) {
        const paramTypes = getFuncParamTypes(ctx, ctorFuncIdx);
        const args = expr.arguments ?? [];
        for (let i = 0; i < args.length; i++) {
          compileExpression(ctx, fctx, args[i]!, paramTypes?.[i]);
        }
        if (paramTypes) {
          for (let i = args.length; i < paramTypes.length; i++) {
            pushDefaultValue(fctx, paramTypes[i]!, ctx);
          }
        }
        const finalIdx = ctx.funcMap.get(cachedFnCtor.ctorFuncName) ?? ctorFuncIdx;
        maybeSetArgcForKnownCall(ctx, fctx, cachedFnCtor.ctorFuncName, args.length, paramTypes?.length ?? args.length);
        fctx.body.push({ op: "call", funcIdx: finalIdx });
        return { kind: "ref", typeIdx: cachedFnCtor.structTypeIdx };
      }
    }
    // Resolve via type checker to find the function declaration
    if (!cachedFnCtor) {
      const exprSymbol = ctx.checker.getSymbolAtLocation(expr.expression);
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
          then: [...stringConstantExternrefInstrs(ctx, rangeErrMsg), { op: "throw", tagIdx } as Instr],
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
          then: [{ op: "f64.const", value: 0 } as Instr, { op: "local.set", index: offsetF64 } as Instr],
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
            then: [...stringConstantExternrefInstrs(ctx, rangeErrMsg), { op: "throw", tagIdx } as Instr],
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
          then: [{ op: "f64.const", value: 0 } as Instr, { op: "local.set", index: lenF64 } as Instr],
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
            then: [...stringConstantExternrefInstrs(ctx, rangeErrMsg), { op: "throw", tagIdx } as Instr],
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
          then: [...stringConstantExternrefInstrs(ctx, rangeErrMsg), { op: "throw", tagIdx } as Instr],
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
            fctx.body.push({ op: "any.convert_extern" } as Instr);
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
      fctx.body.push({ op: "global.get", index: ntGlobalIdx } as Instr);
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
      fctx.body.push({ op: "global.set", index: ntGlobalIdx } as Instr);
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
    for (let i = 0; i < args.length; i++) {
      compileExpression(ctx, fctx, args[i]!, externInfo.constructorParams[i]);
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
    ]);
    if (className && TYPED_ARRAY_CTORS.has(className)) {
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

  // new ArrayBuffer(byteLength) → vec struct with packed i8 elements (1 byte per
  // element, (#2835) — 4× smaller than the former i32-per-byte backing)
  if (className === "ArrayBuffer") {
    const elemType: ValType = { kind: "i8" };
    const vecTypeIdx = getOrRegisterVecType(ctx, "i32_byte", elemType);
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    const args = expr.arguments ?? [];

    // (#3054 C) Resizable ArrayBuffer: `new ArrayBuffer(n, {maxByteLength: m})`.
    // Per §25.1.3.1 / GetArrayBufferMaxByteLengthOption: a non-object options or
    // an options object without a `maxByteLength` property ⇒ NON-resizable (fall
    // through to the plain path below). We handle the object-literal options form
    // (the entire test262 resizable corpus passes an object literal) at compile
    // time — resolving `maxByteLength` off an arbitrary dynamic object would need
    // the object-runtime and is deferred (a dynamic options object stays
    // non-resizable rather than mis-constructing). Host-free lane only: the native
    // vec / `$__resizable_ab` representation exists only standalone (a host-mode
    // ArrayBuffer is a host object — same lane boundary as B1/B2).
    let maxByteLenInit: ts.Expression | undefined;
    if (noJsHost(ctx) && args.length >= 2 && ts.isObjectLiteralExpression(args[1]!)) {
      for (const prop of args[1]!.properties) {
        if (
          ts.isPropertyAssignment(prop) &&
          (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) &&
          prop.name.text === "maxByteLength"
        ) {
          maxByteLenInit = prop.initializer;
        }
      }
    }

    if (maxByteLenInit !== undefined) {
      const rabTypeIdx = getOrRegisterResizableAbType(ctx);
      // byteLength (arg 0) → i32, with the same non-negative-integer RangeError
      // guard the plain path uses.
      compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
      const lenF64 = allocLocal(fctx, `__rab_len_f64_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "local.tee", index: lenF64 });
      fctx.body.push({ op: "local.get", index: lenF64 });
      fctx.body.push({ op: "f64.floor" });
      fctx.body.push({ op: "f64.ne" });
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
          then: [...stringConstantExternrefInstrs(ctx, rangeErrMsg), { op: "throw", tagIdx } as Instr],
          else: [],
        });
      }
      const lenI32 = allocLocal(fctx, `__rab_len_i32_${fctx.locals.length}`, { kind: "i32" });
      fctx.body.push({ op: "local.get", index: lenF64 });
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
      fctx.body.push({ op: "local.set", index: lenI32 });

      // maxByteLength (options) → i32 via ToIndex: NaN→0, truncate toward zero,
      // and `< 0` → RangeError (the upper 2^53-1 bound is subsumed by the i32 cap).
      compileExpression(ctx, fctx, maxByteLenInit, { kind: "f64" });
      const maxF64 = allocLocal(fctx, `__rab_max_f64_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: maxF64 });
      // NaN → 0
      fctx.body.push({ op: "local.get", index: maxF64 });
      fctx.body.push({ op: "local.get", index: maxF64 });
      fctx.body.push({ op: "f64.ne" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "f64.const", value: 0 } as Instr, { op: "local.set", index: maxF64 } as Instr],
        else: [],
      });
      // truncate toward zero
      fctx.body.push({ op: "local.get", index: maxF64 });
      fctx.body.push({ op: "f64.trunc" });
      fctx.body.push({ op: "local.set", index: maxF64 });
      // maxByteLength < 0 → RangeError
      fctx.body.push({ op: "local.get", index: maxF64 });
      fctx.body.push({ op: "f64.const", value: 0 });
      fctx.body.push({ op: "f64.lt" });
      {
        const rangeErrMsg = "RangeError: Invalid array buffer max byte length";
        addStringConstantGlobal(ctx, rangeErrMsg);
        const tagIdx = ensureExnTag(ctx);
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [...stringConstantExternrefInstrs(ctx, rangeErrMsg), { op: "throw", tagIdx } as Instr],
          else: [],
        });
      }
      const maxI32 = allocLocal(fctx, `__rab_max_i32_${fctx.locals.length}`, { kind: "i32" });
      fctx.body.push({ op: "local.get", index: maxF64 });
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
      fctx.body.push({ op: "local.set", index: maxI32 });

      // AllocateArrayBuffer: byteLength > maxByteLength → RangeError.
      fctx.body.push({ op: "local.get", index: lenI32 });
      fctx.body.push({ op: "local.get", index: maxI32 });
      fctx.body.push({ op: "i32.gt_s" });
      {
        const rangeErrMsg = "RangeError: ArrayBuffer byteLength exceeds maxByteLength";
        addStringConstantGlobal(ctx, rangeErrMsg);
        const tagIdx = ensureExnTag(ctx);
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [...stringConstantExternrefInstrs(ctx, rangeErrMsg), { op: "throw", tagIdx } as Instr],
          else: [],
        });
      }

      // struct.new $__resizable_ab { length = byteLength, data = new i8[byteLength],
      // maxByteLength }. The backing array is sized to the CURRENT byteLength (GC
      // arrays are fixed-length; `.resize()` reallocs + swaps `data`, per A.2).
      fctx.body.push({ op: "local.get", index: lenI32 });
      fctx.body.push({ op: "local.get", index: lenI32 });
      fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
      fctx.body.push({ op: "local.get", index: maxI32 });
      fctx.body.push({ op: "struct.new", typeIdx: rabTypeIdx });
      // Return the PARENT vec type: a `$__resizable_ab` IS-A `$__vec_i32_byte`, so
      // every downstream buffer consumer (byteLength, DataView, TA views, slice)
      // treats it identically — only `.resize()`/`.maxByteLength`/`.resizable`
      // `ref.test` the subtype. The runtime value keeps its resizable_ab identity.
      return { kind: "ref_null", typeIdx: vecTypeIdx };
    }

    if (args.length >= 1) {
      // new ArrayBuffer(byteLength) → create vec with byteLength elements, all 0
      compileExpression(ctx, fctx, args[0]!, { kind: "f64" });

      // RangeError validation: byteLength must be a non-negative integer < 2^31
      // (We use i32 internally so cap at i32 max)
      const lenF64Local = allocLocal(fctx, `__ab_len_f64_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "local.tee", index: lenF64Local });
      // Check len != floor(len) (non-integer or NaN)
      fctx.body.push({ op: "local.get", index: lenF64Local });
      fctx.body.push({ op: "f64.floor" });
      fctx.body.push({ op: "f64.ne" });
      // Check len < 0
      fctx.body.push({ op: "local.get", index: lenF64Local });
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
          then: [...stringConstantExternrefInstrs(ctx, rangeErrMsg), { op: "throw", tagIdx } as Instr],
          else: [],
        });
      }

      fctx.body.push({ op: "local.get", index: lenF64Local });
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }

    const sizeLocal = allocLocal(fctx, `__ab_size_${fctx.locals.length}`, {
      kind: "i32",
    });
    fctx.body.push({ op: "local.tee", index: sizeLocal });
    fctx.body.push({ op: "local.get", index: sizeLocal });
    fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
    fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }

  // new DataView(buffer) / new DataView(buffer, byteOffset) / new DataView(buffer, byteOffset, byteLength)
  if (className === "DataView") {
    const elemType: ValType = { kind: "i8" }; // (#2835) packed byte buffer
    const vecTypeIdx = getOrRegisterVecType(ctx, "i32_byte", elemType);
    const args = expr.arguments ?? [];

    if (args.length >= 1) {
      // Compile buffer arg first
      const resultType = compileExpression(ctx, fctx, args[0]!);
      const isStructBuf = resultType !== null && (resultType.kind === "ref" || resultType.kind === "ref_null");

      // Always stash the buffer in a local so we can validate, register the
      // view window via __dv_register_view (#1064), and restore it on stack.
      const bufLocalType: ValType = isStructBuf ? resultType! : { kind: "externref" };
      const bufLocal = allocLocal(fctx, `__dv_buf_${fctx.locals.length}`, bufLocalType);
      fctx.body.push({ op: "local.set", index: bufLocal });

      // Offset and length f64 locals (used for validation AND view-metadata
      // registration). Defaults: offset=0, length=bufferByteLength-offset.
      const offsetF64 = allocLocal(fctx, `__dv_offset_f64_${fctx.locals.length}`, { kind: "f64" });
      const lenF64 = allocLocal(fctx, `__dv_len_f64_${fctx.locals.length}`, {
        kind: "f64",
      });

      if (args.length >= 2) {
        // #1515 ToIndex(byteOffset) per ECMA §7.1.22:
        //   1. If undefined → 0
        //   2. integer = ToIntegerOrInfinity(ToNumber(value))   (NaN → 0; truncate toward 0)
        //   3. If integer < 0 or integer > 2^53-1 → RangeError
        // Previous code threw for any non-integer (1.5 → RangeError) and treated NaN
        // as invalid; spec wants 1.5 → 1 and NaN → 0. Both incorrect behaviors
        // failed `toindex-byteoffset.js` test262 cases.
        compileExpression(ctx, fctx, args[1]!, { kind: "f64" });
        fctx.body.push({ op: "local.set", index: offsetF64 });
        // If NaN, replace with 0 (NaN != NaN is the only condition where v != v).
        fctx.body.push({ op: "local.get", index: offsetF64 });
        fctx.body.push({ op: "local.get", index: offsetF64 });
        fctx.body.push({ op: "f64.ne" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "f64.const", value: 0 } as Instr, { op: "local.set", index: offsetF64 } as Instr],
          else: [],
        });
        // Truncate toward zero (ToIntegerOrInfinity for finite non-NaN).
        fctx.body.push({ op: "local.get", index: offsetF64 });
        fctx.body.push({ op: "f64.trunc" });
        fctx.body.push({ op: "local.set", index: offsetF64 });

        // Check: offset < 0 OR offset > 2^53-1 (ToIndex bounds → RangeError)
        fctx.body.push({ op: "local.get", index: offsetF64 });
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "f64.lt" });
        fctx.body.push({ op: "local.get", index: offsetF64 });
        fctx.body.push({ op: "f64.const", value: 9007199254740991 }); // 2^53 - 1
        fctx.body.push({ op: "f64.gt" });
        fctx.body.push({ op: "i32.or" });

        // If buffer is a vec struct, also check offset > bufferByteLength
        if (isStructBuf) {
          fctx.body.push({ op: "local.get", index: offsetF64 });
          fctx.body.push({ op: "local.get", index: bufLocal });
          fctx.body.push({
            op: "struct.get",
            typeIdx: vecTypeIdx,
            fieldIdx: 0,
          }); // buffer length
          fctx.body.push({ op: "f64.convert_i32_s" });
          fctx.body.push({ op: "f64.gt" });
          fctx.body.push({ op: "i32.or" });
        }

        {
          const rangeErrMsg = "RangeError: Start offset is outside the bounds of the buffer";
          addStringConstantGlobal(ctx, rangeErrMsg);
          const tagIdx = ensureExnTag(ctx);
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [...stringConstantExternrefInstrs(ctx, rangeErrMsg), { op: "throw", tagIdx } as Instr],
            else: [],
          });
        }
      } else {
        // No explicit byteOffset — default to 0
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "local.set", index: offsetF64 });
      }

      if (args.length >= 3) {
        // #1515 ToIndex(byteLength) — same ToIndex semantics as byteOffset above.
        compileExpression(ctx, fctx, args[2]!, { kind: "f64" });
        fctx.body.push({ op: "local.set", index: lenF64 });
        // NaN → 0
        fctx.body.push({ op: "local.get", index: lenF64 });
        fctx.body.push({ op: "local.get", index: lenF64 });
        fctx.body.push({ op: "f64.ne" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "f64.const", value: 0 } as Instr, { op: "local.set", index: lenF64 } as Instr],
          else: [],
        });
        // Truncate toward zero
        fctx.body.push({ op: "local.get", index: lenF64 });
        fctx.body.push({ op: "f64.trunc" });
        fctx.body.push({ op: "local.set", index: lenF64 });

        // Check: len < 0 OR len > 2^53-1 → RangeError
        fctx.body.push({ op: "local.get", index: lenF64 });
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "f64.lt" });
        fctx.body.push({ op: "local.get", index: lenF64 });
        fctx.body.push({ op: "f64.const", value: 9007199254740991 }); // 2^53 - 1
        fctx.body.push({ op: "f64.gt" });
        fctx.body.push({ op: "i32.or" });

        // Check: offset + length > bufferByteLength
        if (isStructBuf) {
          fctx.body.push({ op: "local.get", index: offsetF64 });
          fctx.body.push({ op: "local.get", index: lenF64 });
          fctx.body.push({ op: "f64.add" });
          fctx.body.push({ op: "local.get", index: bufLocal });
          fctx.body.push({
            op: "struct.get",
            typeIdx: vecTypeIdx,
            fieldIdx: 0,
          });
          fctx.body.push({ op: "f64.convert_i32_s" });
          fctx.body.push({ op: "f64.gt" });
          fctx.body.push({ op: "i32.or" });
        }

        {
          const rangeErrMsg = "RangeError: Invalid DataView length";
          addStringConstantGlobal(ctx, rangeErrMsg);
          const tagIdx = ensureExnTag(ctx);
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [...stringConstantExternrefInstrs(ctx, rangeErrMsg), { op: "throw", tagIdx } as Instr],
            else: [],
          });
        }
      } else if (isStructBuf) {
        // Default byteLength = bufferByteLength - offset
        fctx.body.push({ op: "local.get", index: bufLocal });
        fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
        fctx.body.push({ op: "f64.convert_i32_s" });
        fctx.body.push({ op: "local.get", index: offsetF64 });
        fctx.body.push({ op: "f64.sub" });
        fctx.body.push({ op: "local.set", index: lenF64 });
      } else if (noJsHost(ctx)) {
        // (#2159/#38) Standalone externref buffer (the common case — ArrayBuffer
        // locals are typed externref): recover the i32_byte vec struct at runtime
        // (any.convert_extern + ref.cast) and read its byte length, so the default
        // windowed byteLength = bufferByteLength - offset is correct without a
        // host handler.
        fctx.body.push({ op: "local.get", index: bufLocal });
        fctx.body.push({ op: "any.convert_extern" });
        fctx.body.push({ op: "ref.cast", typeIdx: vecTypeIdx });
        fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
        fctx.body.push({ op: "f64.convert_i32_s" });
        fctx.body.push({ op: "local.get", index: offsetF64 });
        fctx.body.push({ op: "f64.sub" });
        fctx.body.push({ op: "local.set", index: lenF64 });
      } else {
        // externref buffer (JS-host) — we can't read length at compile time. Use
        // a NaN sentinel; the runtime __dv_register_view handler treats NaN as
        // "compute from __dv_byte_len(buf) - offset" at dispatch time.
        fctx.body.push({ op: "f64.const", value: NaN });
        fctx.body.push({ op: "local.set", index: lenF64 });
      }

      // #1064: register view metadata with host so the runtime bridge can
      // reconstruct a correctly-windowed native DataView on method dispatch.
      // Always register, even for externref buffers — ArrayBuffer variables
      // in user code are lowered to externref (see checker/type-mapper.ts),
      // but the actual wasmGC struct is what the bridge dispatches on.
      //
      // (#2159) Standalone / WASI mode has no JS host: the accessor
      // (`get/set{Int,Uint,Float}N`) is lowered to pure-Wasm byte reads/writes
      // directly on the i32_byte backing struct (see dataview-native.ts), so
      // there is no runtime bridge to register with. Emitting the host call
      // unconditionally leaked an unsatisfiable `env::__dv_register_view`
      // import, making EVERY `new DataView(...)` a hard instantiate failure
      // standalone. Gate the registration on JS-host mode; standalone evaluates
      // the offset/length args above for their side effects + RangeError checks
      // and then operates on the struct directly. (The view-window base offset
      // for `new DataView(buf, n>0)` is a separate representation slice, shared
      // with TypedArray-on-buffer windowing; offset-0 views — the dominant
      // case — are fully native here.)
      if (!noJsHost(ctx)) {
        const regIdx = ensureLateImport(
          ctx,
          "__dv_register_view",
          [{ kind: "externref" }, { kind: "f64" }, { kind: "f64" }],
          [],
        );
        flushLateImportShifts(ctx, fctx);
        if (regIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: bufLocal });
          if (isStructBuf) {
            fctx.body.push({ op: "extern.convert_any" });
          }
          fctx.body.push({ op: "local.get", index: offsetF64 });
          fctx.body.push({ op: "local.get", index: lenF64 });
          fctx.body.push({ op: "call", funcIdx: regIdx });
        }
      }

      // (#2159/#38) Standalone windowed DataView: when the view has a non-trivial
      // window (an explicit byteOffset > 0, or an explicit byteLength), wrap the
      // shared backing buffer in a `$__dv_window {buf, byteOffset, byteLength}`
      // so the native accessors add the base offset and `dv.byteOffset` /
      // `dv.byteLength` reflect the ctor args. Offset-0 default-length views keep
      // the bare vec representation (the dominant, fully-native case) — the
      // accessor's `recoverDvBacking` accepts both shapes. We only wrap struct
      // buffers (the externref-buffer path has no compile-time struct to share).
      const windowed = noJsHost(ctx) && args.length >= 2;
      if (windowed) {
        const dvWinTypeIdx = getOrRegisterDvWindowType(ctx);
        // buf (ref null vec). The buffer local may be a struct ref already or an
        // externref (ArrayBuffer locals are typed externref) — recover the vec
        // struct so the wrapper's `buf` field is a concrete `(ref null vec)`.
        fctx.body.push({ op: "local.get", index: bufLocal });
        if (!isStructBuf) {
          fctx.body.push({ op: "any.convert_extern" });
          fctx.body.push({ op: "ref.cast", typeIdx: vecTypeIdx });
        }
        // byteOffset (i32) — offsetF64 is already ToIndex-normalized & validated.
        fctx.body.push({ op: "local.get", index: offsetF64 });
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
        // byteLength (i32) — lenF64 holds the windowed length (explicit arg or
        // bufferByteLength - offset default computed above).
        fctx.body.push({ op: "local.get", index: lenF64 });
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
        fctx.body.push({ op: "struct.new", typeIdx: dvWinTypeIdx });
        // DataView locals are externref (EXTERNREF_GLOBAL_NAMES) — hand back an
        // externref so the wrapper survives the variable store and is recovered
        // (any.convert_extern + ref.test $__dv_window) on accessor dispatch.
        fctx.body.push({ op: "extern.convert_any" });
        return { kind: "externref" };
      }

      // Restore buffer on stack
      fctx.body.push({ op: "local.get", index: bufLocal });
      if (isStructBuf) return resultType!;
      if (resultType) return resultType;
      return { kind: "ref_null", typeIdx: vecTypeIdx };
    } else {
      // No buffer — create empty ArrayBuffer-like vec
      const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
      fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
      return { kind: "ref_null", typeIdx: vecTypeIdx };
    }
  }

  // new Array() / new Array(n) / new Array(a, b, c)
  if (className === "Array") {
    // Use contextual type (from variable declaration) if available, else expression type.
    // `new Array()` without type args gives Array<any>, but `var a: number[] = new Array()`
    // needs to produce Array<number> to match the variable's vec type.
    const ctxType = ctx.checker.getContextualType(expr);
    const exprType = ctxType ?? ctx.checker.getTypeAtLocation(expr);
    // If element type is `any` (no contextual type, no explicit type arg),
    // infer from how the array variable is used: scan element assignments
    // like arr[i] = value and arr.push(value) to determine the element type.
    let inferredElemWasm: ValType | null = null;
    const rawTypeArgs = ctx.checker.getTypeArguments(exprType as ts.TypeReference);
    if (rawTypeArgs?.[0] && rawTypeArgs[0].flags & ts.TypeFlags.Any) {
      const inferredElemTsType = inferArrayElementType(ctx, expr);
      if (inferredElemTsType) {
        inferredElemWasm = resolveWasmType(ctx, inferredElemTsType);
      }
    }

    let vecTypeIdx: number;
    let arrTypeIdx: number;
    let elemWasm: ValType;
    if (inferredElemWasm) {
      // Use inferred element type to register/find the right vec type
      const elemKey =
        inferredElemWasm.kind === "ref" || inferredElemWasm.kind === "ref_null"
          ? `ref_${(inferredElemWasm as { typeIdx: number }).typeIdx}`
          : inferredElemWasm.kind;
      vecTypeIdx = getOrRegisterVecType(ctx, elemKey, inferredElemWasm);
      arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      elemWasm = inferredElemWasm;
    } else {
      const resolved = resolveWasmType(ctx, exprType);
      vecTypeIdx = (resolved as { typeIdx: number }).typeIdx;
      arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      const typeArgs = ctx.checker.getTypeArguments(exprType as ts.TypeReference);
      const elemTsType = typeArgs?.[0];
      elemWasm = elemTsType ? resolveWasmType(ctx, elemTsType) : { kind: "f64" };
    }

    // (#2809 Site B) `new Array(undefined, …)` / `new Array<void>(…)`: keep the
    // construction's element/vec representation in lockstep with the
    // `Array<undefined>`/`Array<void>` → externref rule in `resolveWasmType`'s
    // Array branch (#2806 site #3). The vec type above is taken from
    // `resolveWasmType(exprType)` (an externref vec via #3), but `elemWasm` is
    // resolved from the *scalar* undefined element → i32/f64, so `array.new_fixed`
    // pushes a numeric value into an externref array and validation fails
    // (`array.new_fixed[0] expected type externref, f64`) while consumers
    // mis-read `.length`. Force the element (and vec/arr) to externref so the
    // pushed boxed-undefined values, the array.new_* element type, and the vec
    // struct all agree. Pure Undefined/Void only — `number[]` (f64) / `boolean[]`
    // (i32) carry Number/Boolean and `number | undefined` carries the Union flag,
    // so the guard does not fire and they stay numeric.
    {
      const ctorTypeArgs = ctx.checker.getTypeArguments(exprType as ts.TypeReference);
      const ctorElemTs = ctorTypeArgs?.[0];
      const pureUndefinedVoidElem =
        !!ctorElemTs &&
        (elemWasm.kind === "i32" || elemWasm.kind === "f64") &&
        (ctorElemTs.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0 &&
        (ctorElemTs.flags & ~(ts.TypeFlags.Undefined | ts.TypeFlags.Void)) === 0;
      if (pureUndefinedVoidElem) {
        elemWasm = { kind: "externref" };
        vecTypeIdx = getOrRegisterVecType(ctx, "externref", { kind: "externref" });
        arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      }
    }

    // #1197: i32-specialized number[] override — caller (variable-declaration
    // codegen) flagged this `new Array(...)` as belonging to an i32-specialized
    // local. Override the element kind from f64 to i32. We must also re-resolve
    // vecTypeIdx/arrTypeIdx through the i32 registration.
    if (
      elemWasm.kind === "f64" &&
      (ctx as unknown as { _i32ElemArrayOverride?: boolean })._i32ElemArrayOverride === true
    ) {
      elemWasm = { kind: "i32" };
      vecTypeIdx = getOrRegisterVecType(ctx, "i32", { kind: "i32" });
      arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    }

    if (arrTypeIdx < 0) {
      // Fallback: use externref vec type for Array<any> or unresolvable element types
      vecTypeIdx = getOrRegisterVecType(ctx, "externref", {
        kind: "externref",
      });
      arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      elemWasm = { kind: "externref" };
    }

    const args = expr.arguments ?? [];

    if (args.length === 0) {
      // new Array() → empty array with default backing capacity
      // JS arrays are dynamically resizable; wasm arrays are fixed-size.
      // Allocate a default backing buffer so index assignments work.
      const DEFAULT_CAPACITY = 64;
      fctx.body.push({ op: "i32.const", value: 0 }); // length = 0
      fctx.body.push({ op: "i32.const", value: DEFAULT_CAPACITY });
      fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
      fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
      return { kind: "ref_null", typeIdx: vecTypeIdx };
    }

    if (args.length === 1) {
      // new Array(n) → array with capacity n, length 0
      // For test262 patterns like `var a = new Array(16); a[0] = x;`
      // we create an array of size n with default values and set length to n
      // (JS semantics: sparse array with length n, all slots undefined)
      compileExpression(ctx, fctx, args[0]!, { kind: "f64" });

      // RangeError validation: n must be a non-negative integer < 2^32
      // Check: n != floor(n) || n < 0 || n >= 2^32 → throw RangeError
      const nF64Local = allocLocal(fctx, `__arr_n_f64_${fctx.locals.length}`, {
        kind: "f64",
      });
      fctx.body.push({ op: "local.tee", index: nF64Local });
      // Check n != floor(n) (non-integer or NaN)
      fctx.body.push({ op: "local.get", index: nF64Local });
      fctx.body.push({ op: "f64.floor" });
      fctx.body.push({ op: "f64.ne" });
      // Check n < 0
      fctx.body.push({ op: "local.get", index: nF64Local });
      fctx.body.push({ op: "f64.const", value: 0 });
      fctx.body.push({ op: "f64.lt" });
      fctx.body.push({ op: "i32.or" });
      // Check n >= 2^32
      fctx.body.push({ op: "local.get", index: nF64Local });
      fctx.body.push({ op: "f64.const", value: 4294967296 });
      fctx.body.push({ op: "f64.ge" });
      fctx.body.push({ op: "i32.or" });
      // If any check true, throw RangeError
      {
        const rangeErrMsg = "RangeError: Invalid array length";
        addStringConstantGlobal(ctx, rangeErrMsg);
        const tagIdx = ensureExnTag(ctx);
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [...stringConstantExternrefInstrs(ctx, rangeErrMsg), { op: "throw", tagIdx } as Instr],
          else: [],
        });
      }

      fctx.body.push({ op: "local.get", index: nF64Local });
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
      const sizeLocal = allocLocal(fctx, `__arr_size_${fctx.locals.length}`, {
        kind: "i32",
      });
      fctx.body.push({ op: "local.tee", index: sizeLocal });
      fctx.body.push({ op: "local.get", index: sizeLocal });
      fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
      fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
      return { kind: "ref_null", typeIdx: vecTypeIdx };
    }

    // new Array(a, b, c) → [a, b, c]
    for (const arg of args) {
      compileExpression(ctx, fctx, arg, elemWasm);
    }
    fctx.body.push({
      op: "array.new_fixed",
      typeIdx: arrTypeIdx,
      length: args.length,
    });
    const tmpData = allocLocal(fctx, `__arr_data_${fctx.locals.length}`, {
      kind: "ref",
      typeIdx: arrTypeIdx,
    });
    fctx.body.push({ op: "local.set", index: tmpData });
    fctx.body.push({ op: "i32.const", value: args.length });
    fctx.body.push({ op: "local.get", index: tmpData });
    fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }

  reportError(ctx, expr, `Unsupported new expression for class: ${className}`);
  return null;
}

export { compileClassExpression, compileNewExpression, compileSuperElementMethodCall, compileSuperMethodCall };

// #2146: resolveEnclosingClassName is now defined in shared.ts directly (no DI
// slot), so there is no longer a delegate to register here.
registerCompileSuperPropertyAccess(compileSuperPropertyAccess);
registerCompileSuperElementAccess(compileSuperElementAccess);
