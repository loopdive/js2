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
import { isBigIntType, isBooleanType, isNumberType, isStringType } from "../../checker/type-mapper.js";
import { pushDefaultValue } from "../type-coercion.js";
import { compileStandaloneRegExpConstructor, isGlobalRegExpIdentifier } from "../regexp-standalone.js";

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
    ctx.standalone &&
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
  const args = expr.arguments ?? [];

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
    fctx.body.push({ op: "f64.convert_i32_s" } as Instr);
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
  }
  // Unknown / object / externref / union — per spec, `Object(o)` returns `o`
  // unchanged for objects. We can't distinguish primitive-boxed-as-externref
  // from real objects statically, so the best static behavior is identity.
  // (A future revision could call a `__to_object` host helper for runtime
  // ToObject of any-typed values; out of scope for this issue.)
  compileExpression(ctx, fctx, args[0]!, { kind: "externref" });
  return { kind: "externref" };
}
