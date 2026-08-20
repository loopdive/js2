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
import { pushDefaultValue } from "../type-coercion.js";
import { compileStandaloneRegExpConstructor, isGlobalRegExpIdentifier } from "../regexp-standalone.js";

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

  const fact = ctx.oracle.typeFactOf(callee);
  if (!NEVER_CALLABLE_FACT_KINDS.has(fact.kind) && !isFreshlyConstructedNonCallable(ctx, callee, fact.kind)) {
    return undefined;
  }
  // Belt-and-braces: a primitive fact with a call signature is a contradiction,
  // but never throw over one.
  if (ctx.oracle.signatureOf(callee) !== undefined) return undefined;
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
  return !NEVER_CALLABLE_FACT_KINDS.has(initFact.kind) && !isFreshlyConstructedNonCallable(ctx, init, initFact.kind);
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
 */
export function isFreshlyConstructedNonCallable(ctx: CodegenContext, callee: ts.Expression, factKind: string): boolean {
  const brand = ctx.oracle.builtinReceiverOf(callee);
  // `new Function(...)` really is callable; a proxy's [[Call]] comes from its
  // target. Never let either reach the throw.
  if (brand === "Function") return false;
  if (ts.isNewExpression(callee)) {
    const ctorName = ts.isIdentifier(callee.expression) ? callee.expression.text : undefined;
    if (ctorName === "Function" || ctorName === "Proxy") return false;
    // The result of `new` is an ordinary object — `object` is safe HERE (and
    // only here), unlike a checker-typed `{}` binding.
    return factKind === "builtin" || factKind === "class" || factKind === "object";
  }
  // A nominal instance type (`new Number(1)` bound to a variable, an `Error`,
  // `IArguments`, a user class instance) carries no [[Call]] — `factOfType`
  // classifies anything with a call/construct signature as `function` before
  // it can reach `builtin`/`class`. `object` (the structural `{}` fact) is
  // deliberately NOT accepted off the `new` path.
  return factKind === "builtin" || factKind === "class";
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
    // BigInt is i64-represented; `__new_BigInt` boxes via the spec's literal
    // `Object(v)` — `BigInt` is not a constructor, so `new BigInt(v)` throws.
    compileExpression(ctx, fctx, args[0]!, { kind: "i64" });
    const newBigIntIdx = ensureLateImport(ctx, "__new_BigInt", [{ kind: "i64" }], [{ kind: "externref" }]);
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
  // Unknown / object / externref / union — per spec, `Object(o)` returns `o`
  // unchanged for objects. We can't distinguish primitive-boxed-as-externref
  // from real objects statically, so the best static behavior is identity.
  // (A future revision could call a `__to_object` host helper for runtime
  // ToObject of any-typed values; out of scope for this issue.)
  compileExpression(ctx, fctx, args[0]!, { kind: "externref" });
  return { kind: "externref" };
}
