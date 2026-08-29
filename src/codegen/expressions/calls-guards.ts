// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Early-guard handlers extracted from the ~9,400-line compileCallExpression
// (#742). Each handler inspects the call expression and either returns an
// InnerResult (it handled the call) or `undefined` (not its case — the caller
// continues its dispatch). Extracted verbatim so behaviour is identical; the
// only change is threading ctx/fctx/expr as parameters instead of closing over
// the compileCallExpression scope.
import { ts } from "../../ts-api.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { compileExpression } from "../shared.js";
import type { InnerResult } from "../shared.js";
import { emitThrowTypeError } from "./helpers.js";
import { ensureLateImport, flushLateImportShifts } from "./late-imports.js";
import type { Instr, ValType } from "../../ir/types.js";
import { isBigIntType, isBooleanType, isNumberType, isStringType, isSymbolType } from "../../checker/type-mapper.js";
import { noJsHost } from "../js-errors.js";
import { coerceType, pushDefaultValue } from "../type-coercion.js";
import { compileStandaloneRegExpConstructor, isGlobalRegExpIdentifier } from "../regexp-standalone.js";
import { foreignReturnFunctionNames } from "../fnctor-foreign-return.js"; // (#4637 A2) §10.2.1.3 step 13
import { isFreshOrdinaryObjectExpression } from "../native-ordinary-instanceof.js";
import { isObjectLikeFact } from "../object-ctor-primitive-receiver.js";

/**
 * (#4221) Unwrap the transparent wrappers that sit between a call expression
 * and its real callee (`(f)`, `f as T`, `f!`, `<T>f`). Shared by the
 * non-callable guards below.
 */
export function unwrapCallee(expr: ts.Expression): ts.Expression {
  let unwrapped: ts.Expression = expr;
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
  return unwrapped;
}

/**
 * (#4221) The oracle `TypeFact` kinds whose VALUES can never carry a [[Call]]
 * internal method. Deliberately excludes `object` / `class` / `builtin`: a
 * checker-typed `{}` receiver is routinely a JS value the program later
 * decorates with a function property, and `builtin` covers callable brands.
 * `any` / `unknown` / `unresolvable` / `union` are excluded by construction —
 * only a fact that PROVES non-callability may fire this guard.
 */
export const NEVER_CALLABLE_FACT_KINDS = new Set([
  "number",
  "boolean",
  "string",
  "bigint",
  "symbol",
  "undefined",
  "null",
  "void",
]);

/**
 * A JS array whose Wasm storage is externref can receive a callable after
 * TypeScript has fixed its element fact to `undefined` (the #4702 shape:
 * `let f = [undefined]; f[0] = () => 1; f[0]()`).  The element-call tail has a
 * dynamic closure dispatcher for this representation; do not turn its stale
 * primitive fact into an unconditional TypeError before that dispatcher runs.
 * Numeric/typed arrays and non-array structs stay on the static guard.
 */
function isDynamicallyCallableExternrefArrayElement(ctx: CodegenContext, callee: ts.Expression): boolean {
  if (!ts.isElementAccessExpression(callee)) return false;
  const receiverFact = ctx.oracle.typeFactOf(callee.expression);
  return receiverFact.kind === "array" && receiverFact.element.kind === "undefined";
}

/**
 * Standalone runtime-eval global pull-sync can replace an AOT binding after
 * the checker has classified its initializer. In particular, Annex B B.3.3.3
 * turns `var f = 123` into a callable when global eval executes a block-level
 * `function f(){}`. The primitive-callee guard runs before call IR selection,
 * so it must leave those live globals to the native IsCallable dispatcher.
 */
export function runtimeEvalMayReplaceCallee(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callee: ts.Expression,
): boolean {
  if (!ctx.standalone || ctx.runtimeEvalGlobalFunctionBindings !== true || !ts.isIdentifier(callee)) return false;
  const name = callee.text;
  if (fctx.localMap.has(name)) return false;
  return (ctx.globalObjectVarBindings?.has(name) ?? false) || (ctx.globalLexicalBindings?.has(name) ?? false);
}

/**
 * (#4206) Is `callee` a MODULE-scope Annex B B.3.3.2 block-function binding?
 *
 * B.3.3.2.c makes such a name live: the value a call must invoke is whatever
 * declaration most recently evaluated. TypeScript has no notion of that, so a
 * later `var f = 123` anywhere in the script is the ONLY thing it types the
 * name from — and this guard then reads a `number` fact and bakes an
 * unconditional TypeError into a call the spec says must succeed:
 *
 * ```js
 * { function f() { return "function declaration"; } }
 * f();          // spec: "function declaration"; before this bail: TypeError
 * var f = 123;  // the ONLY reason the checker calls `f` a number
 * ```
 *
 * `registerAnnexBGlobalLiveBindings` has already widened the backing global to
 * `externref` for exactly this reason, so the value at the call site really is
 * the closure; only the static fact disagrees. Same shape as the runtime-eval
 * bail above, and gated on the normally-empty `annexBModuleBindings` set, so
 * every program without a module-scope sloppy block function is unaffected.
 * A locally-shadowed name keeps its local resolution and its fact.
 */
function annexBBlockFunctionBinding(ctx: CodegenContext, fctx: FunctionContext, callee: ts.Expression): boolean {
  if (!ts.isIdentifier(callee) || fctx.localMap.has(callee.text)) return false;
  return ctx.annexBModuleBindings?.has(callee.text) === true;
}

/**
 * (#4221) §13.3.6.2 EvaluateCall steps 4-5 — calling a value that is provably
 * NOT callable must throw a TypeError. Before this guard the callee fell to
 * `compileCallExpression`'s last-resort arm, which compiles the callee + args
 * for side effects and answers `ref.null.extern`, so `true()` / `"s"()` /
 * `null()` / `(new Number(1))()` silently evaluated to `undefined`
 * (`language/expressions/call/S11.2.3_A3_T*`, `_A4_T*` — failing in BOTH the
 * gc and standalone lanes).
 *
 * Firing condition is intentionally narrow: the callee's oracle fact must be a
 * PRIMITIVE kind (see NEVER_CALLABLE_FACT_KINDS) AND the type must expose no
 * call signature. Anything the oracle cannot prove — `any`, unions, objects,
 * unresolved identifiers — keeps the legacy behaviour, because a false
 * positive converts a working call into a hard runtime throw.
 *
 * Evaluation order follows the spec: the callee reference is evaluated (for
 * side effects) BEFORE the argument list, and the TypeError is raised only
 * after both, so `f(sideEffect())` still runs `sideEffect`.
 */
export function tryNonCallableValueCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | undefined {
  // An optional call (`f?.()`) short-circuits on nullish instead of throwing.
  if (expr.questionDotToken !== undefined || ts.isOptionalChain(expr)) return undefined;

  const callee = unwrapCallee(expr.expression);
  // `super(...)` / `import(...)` are not value calls.
  if (callee.kind === ts.SyntaxKind.SuperKeyword || callee.kind === ts.SyntaxKind.ImportKeyword) return undefined;

  // Global eval can change the value and representation of these bindings
  // after static type analysis. Preserve runtime IsCallable semantics instead
  // of baking the initializer's primitive fact into an unconditional throw.
  if (runtimeEvalMayReplaceCallee(ctx, fctx, callee)) return undefined;
  if (annexBBlockFunctionBinding(ctx, fctx, callee)) return undefined;

  // #4702 — an externref array element may have been populated with a closure
  // after the checker recorded the initial `undefined` element fact. Let the
  // element-call dispatcher inspect the runtime value before applying the
  // primitive non-callable guard.
  if (isDynamicallyCallableExternrefArrayElement(ctx, callee)) return undefined;

  const fact = ctx.oracle.typeFactOf(callee);
  if (!NEVER_CALLABLE_FACT_KINDS.has(fact.kind) && !isFreshlyConstructedNonCallable(ctx, callee, fact.kind)) {
    return undefined;
  }
  // Belt-and-braces: a primitive fact with a call signature is a contradiction,
  // but never throw over one.
  if (ctx.oracle.signatureOf(callee) !== undefined) return undefined;
  // A call expression can return a callable carrier even when its inferred
  // JavaScript type is the broad `{}` object shape (Redux's
  // `bindActionCreators` is one such published-JS example).  The nominal
  // `class` fact is therefore not proof that this binding is non-callable;
  // leave the value for identifier/dynamic-call lowering to inspect its
  // runtime closure carrier.
  const variableInitializer = ts.isIdentifier(callee) ? ctx.oracle.variableInitializerOf(callee) : undefined;
  if (variableInitializer !== undefined && ts.isCallExpression(variableInitializer)) {
    return undefined;
  }
  if (isEvolvingAnyBinding(ctx, callee)) return undefined;

  // Callee first (side effects), then the argument list, then the throw.
  const calleeType = compileExpression(ctx, fctx, callee);
  if (calleeType) fctx.body.push({ op: "drop" });
  for (const arg of expr.arguments) {
    const argType = compileExpression(ctx, fctx, arg);
    if (argType) fctx.body.push({ op: "drop" });
  }
  emitThrowTypeError(ctx, fctx, `${describeNonCallableCallee(callee, fact.kind)} is not a function`);
  fctx.body.push({ op: "ref.null.extern" });
  return { kind: "externref" };
}

/**
 * (#4221) THE false-positive guard for the primitive arm, and the reason this
 * whole guard is not simply "the checker says primitive".
 *
 * `var probe; function f(){ probe = function(){…} } f(); probe();` is the
 * canonical test262 *probe* idiom. `probe` is an implicit-any ("evolving any")
 * binding; TypeScript's control-flow analysis sees no assignment reachable at
 * the call site (the write happens inside a nested function), so it reports
 * the flow type as `undefined` — and a naive primitive check would compile a
 * working call into a hard TypeError. Measured: it flipped
 * `language/statements/function/scope-param-rest-elem-var-close.js` from pass
 * to fail before this guard existed.
 *
 * So: a plain identifier callee only reaches the throw when its declaration
 * commits to the type — an explicit type annotation, or an initializer that is
 * itself provably non-callable. A `var x;` with neither is evolving-any and is
 * left alone.
 */
export function isEvolvingAnyBinding(ctx: CodegenContext, callee: ts.Expression): boolean {
  if (!ts.isIdentifier(callee)) return false;
  // The global `undefined` is not a binding anyone can reassign.
  if (callee.text === "undefined") return false;
  const decl = ctx.oracle.variableDeclarationOf(callee);
  if (decl === undefined) return false; // parameter / function / import / global
  if (decl.type !== undefined) return false; // annotated ⇒ the type is a commitment
  const init = ctx.oracle.variableInitializerOf(callee);
  if (init === undefined) return true; // `var x;` — evolving any
  // An initializer commits the widened declared type only when the initializer
  // itself is non-callable; anything else (including `any`) stays untouched.
  const initFact = ctx.oracle.typeFactOf(init);
  // (#4616) `let x = null; … x = function(){…}; x()` — the deferred-init
  // idiom (cookie's `__upstreamSnapshotMatcher`). A NULLISH initializer on a
  // MUTABLE unannotated binding commits nothing: TS infers the literal
  // `null`/`undefined` type and closure-crossing flow analysis reports it at
  // the call site even after a function was assigned. Only `const` makes a
  // nullish initializer a real commitment.
  if (initFact.kind === "null" || initFact.kind === "undefined") {
    const list = decl.parent;
    const isConst = ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0;
    // (#4640 D1) …unless NOTHING in the module ever re-targets the binding.
    //
    // The #4616 carve-out is about a binding whose value MOVES: `let x = null;
    // … x = function(){…}; x()`. Its justification is that TypeScript's
    // closure-crossing flow analysis still reports `null` at the call site, so
    // the initializer is not a commitment. That justification evaporates when
    // the source contains no write to the name at all — then the initializer is
    // the only value the binding can ever hold, and `var x = undefined; x()`
    // (`language/expressions/call/S11.2.3_A3_T4`/`T5`,
    // `expressions/new/S11.2.2_A3_T4`/`T5`) is a §13.3.6.1 TypeError that this
    // guard was declining to raise.
    //
    // A pure RUNTIME nullish check cannot substitute for this: measured on the
    // base branch, `var x = undefined` lowers to an **f64 NaN** local, so the
    // externref read at the call site is a boxed NUMBER — neither `ref.is_null`
    // nor `__extern_is_undefined` answers true for it. The undefined-ness is a
    // static fact here or it is nowhere.
    if (!isConst && nullishBindingIsRetargeted(callee)) return true;
  }
  if (isFreshlyConstructedAlias(ctx, callee)) return false;
  return !NEVER_CALLABLE_FACT_KINDS.has(initFact.kind) && !isFreshlyConstructedNonCallable(ctx, init, initFact.kind);
}

/**
 * (#4640 D1) True when the module contains ANY construct that could give
 * `callee`'s binding a different value than its nullish initializer.
 *
 * Deliberately OVER-approximates — every "maybe" answers `true`, which keeps
 * the #4616 carve-out in force and leaves the call alone. Counted as a
 * re-target:
 *
 *  - any assignment (`=` … `??=`) whose LEFT SUBTREE mentions the name, which
 *    covers `x = f`, `[x] = a`, `({x} = o)` and, harmlessly, `o[x] = 1`;
 *  - `++x` / `x--`;
 *  - a `for (x in o)` / `for (x of a)` head that assigns to the bare name;
 *  - a second `var`/`let` declaration of the same name that HAS an initializer
 *    (hoisted `var` redeclaration is one binding, so the later initializer is a
 *    write to it).
 *
 * A whole-file scan, like `identifierIsWrittenTo`'s: a shadowing binding of the
 * same name elsewhere can only make this answer `true` and therefore only make
 * the guard decline.
 */
function nullishBindingIsRetargeted(callee: ts.Identifier): boolean {
  const name = callee.text;
  const file = callee.getSourceFile();
  if (file === undefined) return true; // synthesized node — cannot scan, assume the worst
  const mentionsName = (node: ts.Node): boolean => {
    if (ts.isIdentifier(node) && node.text === name) return true;
    let hit = false;
    ts.forEachChild(node, (child) => {
      if (!hit && mentionsName(child)) hit = true;
    });
    return hit;
  };
  let retargeted = false;
  const visit = (node: ts.Node): void => {
    if (retargeted) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      mentionsName(node.left)
    ) {
      retargeted = true;
      return;
    }
    if (
      (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) &&
      ts.isIdentifier(node.operand) &&
      node.operand.text === name
    ) {
      retargeted = true;
      return;
    }
    if (
      (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer) &&
      mentionsName(node.initializer)
    ) {
      retargeted = true;
      return;
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer !== undefined &&
      node.name !== callee
    ) {
      // The declaration this call's binding came from is nullish by
      // construction (the caller already checked its initializer fact); a
      // SECOND initialized declaration of the same name is a re-target.
      const initFactIsNullish =
        node.initializer.kind === ts.SyntaxKind.NullKeyword ||
        (ts.isIdentifier(node.initializer) && node.initializer.text === "undefined");
      if (!initFactIsNullish) {
        retargeted = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return retargeted;
}

/**
 * (#4221) `new Number(1)()` / `new String("x")()` / `new Foo()()` — a `new`
 * expression yields an ordinary object, so calling its result is a TypeError
 * (`language/expressions/call/S11.2.3_A4_T1..T3`). Restricting the object-ish
 * facts (`builtin` / `class` / `object`) to a SYNTACTIC `new` is what makes
 * this safe: a checker-typed `{}` binding is routinely a value the program
 * later decorates with a function property, whereas the result of `new` is
 * never retroactively something else.
 *
 * `Function` and `Proxy` are excluded — `new Function(...)` IS callable, and a
 * proxy's [[Call]] comes from its target.
 *
 * (#4637 A2) A user constructor whose body can `return` a FOREIGN value is
 * excluded for the SAME reason, and it is not a corner case: §10.2.1.3 step 13
 * makes that returned value the construction result, so
 *
 *     var __func = function(a,b){ this.first=a; __gunc.prop=b; return __gunc;
 *                                 function __gunc(arg){return ++arg} };
 *     var __instance = new __func("one","two");
 *     __instance(1)                       // spec: 2
 *
 * is a call on a FUNCTION. Measured on this branch's base (`.tmp/p6.js`,
 * `--target standalone`): `__instance === __gunc` and `__instance.prop` are
 * already right — the override lands — and only `typeof` and the call
 * disagreed, because both read the checker's INSTANCE shape. That is exactly
 * the inference `fnctor-foreign-return.ts` exists to distrust (`resolveWasmType`
 * already degrades the SLOT to externref off the same predicate); this guard was
 * the one consumer still trusting it, and it turned a working call into a hard
 * `__instance is not a function` throw — `S13.2.2_A8_T1`/`_T2`.
 */
export function isFreshlyConstructedNonCallable(ctx: CodegenContext, callee: ts.Expression, factKind: string): boolean {
  const brand = ctx.oracle.builtinReceiverOf(callee);
  // `new Function(...)` really is callable; a proxy's [[Call]] comes from its
  // target. Never let either reach the throw.
  if (brand === "Function") return false;
  if (ts.isNewExpression(callee)) {
    const ctorName = ts.isIdentifier(callee.expression) ? callee.expression.text : undefined;
    if (ctorName === "Function" || ctorName === "Proxy") return false;
    if (ctorName !== undefined && foreignReturnFunctionNames(callee.getSourceFile()).has(ctorName)) return false;
    if (ctorName === "Object" && objectCoercionMayBeCallable(ctx, callee.arguments)) return false;
    // The result of `new` is an ordinary object — `object` is safe HERE (and
    // only here), unlike a checker-typed `{}` binding.
    return factKind === "builtin" || factKind === "class" || factKind === "object";
  }
  // A single-assignment alias preserves the non-callability of a freshly
  // constructed ordinary object. The checker reports untyped JavaScript
  // aliases as `any`, so the direct-`new` arm above cannot see them and the
  // call used to fall through to the silent undefined result. The helper
  // requires a syntactic object / `new` initializer and a no-value-returning
  // user constructor, and declines on any binding write; a later assignment
  // may therefore replace the object with a callable value.
  if (isFreshlyConstructedAlias(ctx, callee)) return true;
  // A nominal instance type (`new Number(1)` bound to a variable, an `Error`,
  // `IArguments`, a user class instance) carries no [[Call]] — `factOfType`
  // classifies anything with a call/construct signature as `function` before
  // it can reach `builtin`/`class`. `object` (the structural `{}` fact) is
  // deliberately NOT accepted off the `new` path.
  return factKind === "builtin" || factKind === "class";
}

/**
 * True for a single-assignment binding whose initializer is a `new` expression
 * producing an ordinary object. Keep this alias arm narrower than
 * `isFreshOrdinaryObjectExpression`: object-literal aliases are a separate
 * call-dispatch question, while this residual is specifically the untyped
 * `var instance = new Ctor()` form.
 */
function isFreshlyConstructedAlias(ctx: CodegenContext, expr: ts.Expression): boolean {
  if (!ts.isIdentifier(expr)) return false;
  const initializer = ctx.oracle.variableInitializerOf(expr);
  return initializer !== undefined && ts.isNewExpression(initializer) && isFreshOrdinaryObjectExpression(ctx, expr);
}

/**
 * (#4637 A3) `Object(x)` / `new Object(x)` is §7.1.18 ToObject, and ToObject on
 * an object is the IDENTITY — so `new Object(f)` where `f` is a function IS that
 * function, callable, `=== f`. Measured on this branch's base (`.tmp/p8.js`,
 * `--target standalone`): the identity already holds — `emitObjectCoercion`'s
 * fallback compiles the argument to externref, which preserves the closure — and
 * the only thing that disagreed was the checker's `Object` type for the
 * expression, which drove `typeof` to the constant `"object"` and this guard to
 * a hard `n_obj is not a function` throw (`built-ins/Object/S15.2.2.1_A2_T2`,
 * `_A2_T6`).
 *
 * Answers "the result of this ToObject may be callable". It is a decline
 * predicate, so it must err toward `true`: `new Object()` (no argument) and
 * `new Object(<provably-primitive>)` answer `false` and keep the guard, which is
 * what `language/expressions/call/S11.2.3_A4_*` needs; anything the oracle
 * cannot classify as a primitive answers `true` and the call is left to the
 * runtime dispatcher.
 */
export function objectCoercionMayBeCallable(
  ctx: CodegenContext,
  args: ts.NodeArray<ts.Expression> | undefined,
): boolean {
  const arg = args?.[0];
  if (arg === undefined) return false; // `new Object()` — a fresh plain object
  const argFact = ctx.oracle.typeFactOf(arg);
  if (NEVER_CALLABLE_FACT_KINDS.has(argFact.kind)) return false;
  // A nested `new` whose own result is provably non-callable stays so through
  // ToObject (`new Object(new Number(1))()` must still throw).
  return !isFreshlyConstructedNonCallable(ctx, arg, argFact.kind);
}

/**
 * (#4221) Best-effort callee text for the TypeError message. `getText()` reads
 * the source file, which a SYNTHESIZED node does not have — `compileCallExpression`
 * builds one for its binary-RHS retry — so a failure here falls back to the
 * fact kind rather than aborting codegen.
 */
function describeNonCallableCallee(callee: ts.Expression, factKind: string): string {
  if (ts.isIdentifier(callee) || ts.isPropertyAccessExpression(callee)) {
    try {
      const text = callee.getText();
      if (text.length > 0 && text.length <= 40) return text;
    } catch {
      /* synthesized node — fall through to the fact kind */
    }
  }
  return factKind;
}

/**
 * (#1732) Calling a built-in non-constructor namespace — `Math()`, `JSON()`,
 * `Reflect()`, `Atomics()` — must throw TypeError ("no [[Call]]"). These
 * namespace objects have neither a [[Call]] nor [[Construct]] internal method
 * (§sec-math-object etc.). The `new`-site already throws via the mirror guard
 * in new-super.ts (NAMESPACE_NON_CONSTRUCTORS); this closes the call-as-function
 * form (built-ins/Math/prop-desc.js "no [[Call]]"). Unwrap paren/as/!-assertion
 * wrappers so `(Math as any)()` also fires.
 *
 * Returns an externref result when it throws; `undefined` when the callee is not
 * a non-callable namespace identifier (caller continues dispatch).
 */
export function tryNamespaceNonCallable(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | undefined {
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
    // #2180 — `Proxy(t,h)` without `new` must throw TypeError: the Proxy exotic
    // has [[Construct]] but no [[Call]]. The `new Proxy` form is handled
    // separately in new-super.ts; member calls like `Proxy.revocable(...)` reach
    // a different branch (this guard only fires for a bare-identifier callee), so
    // listing it here is safe.
    const NAMESPACE_NON_CALLABLE = new Set(["Math", "JSON", "Reflect", "Atomics", "Proxy"]);
    if (NAMESPACE_NON_CALLABLE.has(unwrapped.text)) {
      // Evaluate arguments for their side effects (spec: argument list is
      // evaluated before the [[Call]] check would normally run), then throw.
      for (const arg of expr.arguments) {
        const t = compileExpression(ctx, fctx, arg);
        if (t !== null && t !== undefined) fctx.body.push({ op: "drop" });
      }
      emitThrowTypeError(ctx, fctx, `${unwrapped.text} is not a function`);
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }
  }
  return undefined;
}

/**
 * (#1540) JSX runtime call intercept — `_jsx(type, props, key?)` /
 * `_jsxs(type, props, key?)` / `_jsxDEV(...)`. TypeScript emits these
 * automatically when `jsx: react-jsx` is set; preprocessImports recorded the
 * actual local-binding names in `ctx.jsxRuntime`. We route the call to the
 * matching `__jsx_runtime_*` host import (registered in
 * `registerJsxRuntimeImports`), passing args as externref.
 *
 * Returns an externref result when it intercepts; `undefined` otherwise.
 */
export function tryJsxRuntimeCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | undefined {
  if (ctx.jsxRuntime && ts.isIdentifier(expr.expression)) {
    const name = expr.expression.text;
    let method: "jsx" | "jsxs" | "jsxDEV" | undefined;
    let arity = 3;
    if (ctx.jsxRuntime.localJsx === name) {
      method = "jsx";
      arity = 3;
    } else if (ctx.jsxRuntime.localJsxs === name) {
      method = "jsxs";
      arity = 3;
    } else if (ctx.jsxRuntime.localJsxDev === name) {
      method = "jsxDEV";
      arity = 6;
    }
    if (method) {
      const importName = `__jsx_runtime_${method}`;
      const ext: ValType = { kind: "externref" };
      const params: ValType[] = Array.from({ length: arity }, () => ext);
      const funcIdx = ensureLateImport(ctx, importName, params, [ext]);
      if (funcIdx !== undefined) {
        flushLateImportShifts(ctx, fctx);
        // Compile up to `arity` args as externref, padding shortfalls with
        // ref.null.extern. Excess args (rare) are evaluated and dropped.
        const argCount = Math.min(arity, expr.arguments.length);
        for (let i = 0; i < argCount; i++) {
          compileExpression(ctx, fctx, expr.arguments[i]!, { kind: "externref" });
        }
        for (let i = argCount; i < arity; i++) {
          fctx.body.push({ op: "ref.null.extern" });
        }
        for (let i = arity; i < expr.arguments.length; i++) {
          const t = compileExpression(ctx, fctx, expr.arguments[i]!);
          if (t) fctx.body.push({ op: "drop" });
        }
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
    }
  }
  return undefined;
}

/**
 * `RegExp(pattern, flags)` called without `new` — per spec, equivalent to
 * `new RegExp(pattern, flags)` (unless pattern is already a RegExp with flags
 * undefined, an edge case we accept). Host mode emits RegExp_new directly;
 * standalone mode routes static literal patterns to #682's native subset and
 * keeps unsupported forms on the explicit refusal path.
 *
 * Returns an externref result when it handles the call; `undefined` otherwise.
 */
export function tryRegExpConstructorCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | undefined {
  if (
    ctx.targetProfile.semanticProviders === "native-first" &&
    !expr.questionDotToken &&
    ts.isIdentifier(expr.expression) &&
    isGlobalRegExpIdentifier(ctx, expr.expression)
  ) {
    return compileStandaloneRegExpConstructor(ctx, fctx, expr.arguments ?? [], expr);
  }

  if (
    !expr.questionDotToken &&
    ts.isIdentifier(expr.expression) &&
    isGlobalRegExpIdentifier(ctx, expr.expression) &&
    ctx.externClasses.has("RegExp")
  ) {
    const externInfo = ctx.externClasses.get("RegExp")!;
    const importName = `${externInfo.importPrefix}_new`;
    const funcIdx = ctx.funcMap.get(importName);
    if (funcIdx !== undefined) {
      const args = expr.arguments ?? [];
      for (let i = 0; i < args.length; i++) {
        compileExpression(ctx, fctx, args[i]!, externInfo.constructorParams[i]);
      }
      for (let i = args.length; i < externInfo.constructorParams.length; i++) {
        pushDefaultValue(fctx, externInfo.constructorParams[i]!, ctx);
      }
      const finalIdx = ctx.funcMap.get(importName) ?? funcIdx;
      fctx.body.push({ op: "call", funcIdx: finalIdx });
      return { kind: "externref" };
    }
  }
  return undefined;
}

/**
 * `Object(x)` called without `new` — ECMAScript §20.1.1.1 / §7.1.18 ToObject.
 * Per spec: Object() / Object(null) / Object(undefined) → fresh empty object;
 * Object(number) → new Number wrapper (typeof === "object");
 * Object(string) → new String wrapper; Object(boolean) → new Boolean wrapper;
 * Object(object) → return the argument unchanged.
 * (#1129) Without this, `Object(42)` fell through to the generic builtin path
 * which produced `ref.null.extern`.
 *
 * Returns an externref result when the callee is `Object`; `undefined` otherwise.
 */
export function tryObjectCoercionCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | undefined {
  if (!(!expr.questionDotToken && ts.isIdentifier(expr.expression) && expr.expression.text === "Object")) {
    return undefined;
  }
  return emitObjectCoercion(ctx, fctx, expr.arguments ?? []);
}

/**
 * (#3118) Emit the ECMAScript §20.1.1.1 / §7.1.18 ToObject coercion for the
 * arguments of an `Object(...)` **or** `new Object(...)` construct. Both forms
 * are spec-identical: for a primitive first arg they return the matching
 * wrapper object (Number/String/Boolean/BigInt), for null/undefined/no-arg a
 * fresh plain object, and for an object the argument unchanged. Shared by
 * `tryObjectCoercionCall` (the call form) and the `new Object(arg)` path in
 * new-super.ts — before #3118 the `new` form ignored its argument and always
 * built an empty object, so `new Object(42)` stringified to "[object Object]"
 * instead of "42" (breaking every method-borrow-onto-boxed-primitive test).
 */
export function emitObjectCoercion(
  ctx: CodegenContext,
  fctx: FunctionContext,
  args: readonly ts.Expression[],
): InnerResult {
  // Object() / Object(null) / Object(undefined) → fresh empty object via
  // `__new_plain_object`. Mirrors the `new Object()` path in new-super.ts so the
  // result is a real object with the ordinary `Object.prototype` (Boolean(...) ===
  // true, and ToPrimitive finds toString/valueOf so `Object() == 0` etc. don't
  // throw — #1525).
  const isNullOrUndefinedArg = (a: ts.Expression): boolean => {
    if (a.kind === ts.SyntaxKind.NullKeyword) return true;
    if (ts.isIdentifier(a) && a.text === "undefined") return true;
    const t = ctx.checker.getTypeAtLocation(a);
    const f = t.getFlags();
    // Type-only check — only treat as null/undefined when the static type is
    // *exactly* null/undefined/void (not unions that include other types).
    const NULL_UNDEFINED_VOID = ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void;
    return (f & NULL_UNDEFINED_VOID) !== 0 && (f & ~NULL_UNDEFINED_VOID) === 0;
  };

  if (args.length === 0 || isNullOrUndefinedArg(args[0]!)) {
    const createIdx = ensureLateImport(ctx, "__new_plain_object", [], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
    const finalCreateIdx = ctx.funcMap.get("__new_plain_object") ?? createIdx;
    if (finalCreateIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: finalCreateIdx });
      return { kind: "externref" };
    }
    // Fallback if host import unavailable (standalone) — emit null externref.
    // typeof null === "object" still satisfies the §20.1.1.1 typeof contract.
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  // §7.1.18 is an identity operation for an object argument.  In the
  // standalone backend an object-valued struct can otherwise be reified by
  // `compileExpression(..., { kind: "externref" })` when it carries a
  // user-defined `valueOf`/`toString`; that materialization creates a new
  // `$Object` mirror and changes `Object(x) === x`.  Prove the argument is
  // already an object before the primitive wrapper arms and cross the raw
  // carrier directly, preserving identity (and the object's live methods).
  // Unknown/`any` values deliberately keep the existing fallback below.
  if (noJsHost(ctx)) {
    const argFact = ctx.oracle.typeFactOf(args[0]!);
    if (isObjectLikeFact(argFact)) {
      const argResult = compileExpression(ctx, fctx, args[0]!);
      if (argResult === null) {
        fctx.body.push({ op: "ref.null.extern" });
      } else if (argResult.kind !== "externref") {
        if (
          argResult.kind === "ref" ||
          argResult.kind === "ref_null" ||
          argResult.kind === "anyref" ||
          argResult.kind === "eqref"
        ) {
          fctx.body.push({ op: "extern.convert_any" });
        } else {
          coerceType(ctx, fctx, argResult, { kind: "externref" });
        }
      }
      return { kind: "externref" };
    }
  }

  // Object(primitive) — wrap into the corresponding wrapper object.
  const argTsType = ctx.checker.getTypeAtLocation(args[0]!);

  if (isNumberType(argTsType)) {
    compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
    const newNumIdx = ensureLateImport(ctx, "__new_Number", [{ kind: "f64" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
    const finalNumIdx = ctx.funcMap.get("__new_Number") ?? newNumIdx;
    if (finalNumIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: finalNumIdx });
      return { kind: "externref" };
    }
  } else if (isStringType(argTsType)) {
    compileExpression(ctx, fctx, args[0]!, { kind: "externref" });
    const newStrIdx = ensureLateImport(ctx, "__new_String", [{ kind: "externref" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
    const finalStrIdx = ctx.funcMap.get("__new_String") ?? newStrIdx;
    if (finalStrIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: finalStrIdx });
      return { kind: "externref" };
    }
  } else if (isBooleanType(argTsType)) {
    // __new_Boolean takes f64 — coerce bool→f64.
    compileExpression(ctx, fctx, args[0]!, { kind: "i32" });
    fctx.body.push({ op: "f64.convert_i32_s" });
    const newBoolIdx = ensureLateImport(ctx, "__new_Boolean", [{ kind: "f64" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
    const finalBoolIdx = ctx.funcMap.get("__new_Boolean") ?? newBoolIdx;
    if (finalBoolIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: finalBoolIdx });
      return { kind: "externref" };
    }
  } else if (isBigIntType(argTsType)) {
    // (#1568) Object(bigint) → BigInt wrapper object (§7.1.18 Table 13).
    // A JS-host BigInt must stay an externref here: forcing a wide value through
    // the standalone i64 carrier truncates it before Object(v) can preserve the
    // primitive in the wrapper's [[BigIntData]] slot. Native-first/host-free
    // targets keep the established i64 ABI and native `$BigInt` wrapper.
    const hostBigInt = !ctx.standalone && !ctx.wasi && ctx.targetProfile.semanticProviders !== "native-first";
    const bigIntCarrier: ValType = hostBigInt ? { kind: "externref" } : { kind: "i64", bigint: true };
    compileExpression(ctx, fctx, args[0]!, bigIntCarrier);
    const newBigIntIdx = ensureLateImport(ctx, "__new_BigInt", [bigIntCarrier], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
    const finalBigIntIdx = ctx.funcMap.get("__new_BigInt") ?? newBigIntIdx;
    if (finalBigIntIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: finalBigIntIdx });
      return { kind: "externref" };
    }
  } else if (isSymbolType(argTsType) && !noJsHost(ctx)) {
    // (#2728) Object(sym) → Symbol-wrapper object (§7.1.18 ToObject, Table 13),
    // whose `typeof` is "object". Symbol is NOT a constructor, so the generic
    // `__new_<Ctor>` (`new Symbol(id)`) path throws — mirror the `__new_BigInt`
    // (#1568) approach with a dedicated `__new_Symbol` host helper that boxes
    // the i32 symbol id to the real JS Symbol (reusing the same per-instance
    // id→Symbol cache as `__box_symbol`, so identity/description round-trip) and
    // returns `Object(sym)`. Symbols compile to a bare i32 counter id.
    // Standalone / no-JS-host: no host wrapper — fall through to identity below.
    compileExpression(ctx, fctx, args[0]!, { kind: "i32" });
    const newSymIdx = ensureLateImport(ctx, "__new_Symbol", [{ kind: "i32" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
    const finalSymIdx = ctx.funcMap.get("__new_Symbol") ?? newSymIdx;
    if (finalSymIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: finalSymIdx });
      return { kind: "externref" };
    }
  }
  // Unknown / object / externref / union. (#4530) In host mode, route through
  // the `__to_object` host helper: it performs the real §7.1.18 ToObject at
  // runtime (primitive → wrapper object, object → identity), so
  // `Object(value) !== value` distinguishes primitives even when the static
  // type is `any` (jest-get-type's isPrimitive). Standalone / no-JS-host keeps
  // the historical identity fallback — a native ToObject is separate work.
  compileExpression(ctx, fctx, args[0]!, { kind: "externref" });
  if (!noJsHost(ctx)) {
    const toObjIdx = ensureLateImport(ctx, "__to_object", [{ kind: "externref" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
    const finalToObjIdx = ctx.funcMap.get("__to_object") ?? toObjIdx;
    if (finalToObjIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: finalToObjIdx });
    }
  }
  return { kind: "externref" };
}
