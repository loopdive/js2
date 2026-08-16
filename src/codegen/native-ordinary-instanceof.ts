// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#2916) Two host-free answers for the fully-dynamic `instanceof` path under
 * `--target standalone` / `--target wasi`.
 *
 * ## The leak this closes
 *
 * `emitDynamicInstanceOf` emits `env::__instanceof_check` — the host predicate
 * that implements §13.10.2 InstanceofOperator + §7.3.20 OrdinaryHasInstance. A
 * host-free binary cannot satisfy it, so the module does not instantiate and the
 * #2961 leak guard refuses the test. Measured on the ≤ES5 standalone baseline of
 * 2026-08-07: **10 files name `__instanceof_check` as their SOLE host import**,
 * all under `language/expressions/instanceof/`.
 *
 * #3962 already answered the `value instanceof <user function constructor>`
 * shape natively. What remained splits into two spec steps this module covers,
 * plus one it deliberately does NOT (see "Not covered" below).
 *
 * ## Step 1 — IsCallable(C) is false ⇒ TypeError (§7.3.20 step 1)
 *
 * `f instanceof f`, `x instanceof someObject` — the RHS is an OBJECT (so the
 * §13.10.2 step 1 "not an object" throw, which `compileHostInstanceOf` already
 * emits for a statically-primitive RHS, does not apply) but is not callable.
 * When the checker proves the RHS type has NO call and NO construct signature,
 * the operator throws unconditionally after evaluating both operands (§13.10.1
 * evaluates RelationalExpression then ShiftExpression before the check).
 *
 * ## Step 2 — a builtin constructor reached through an alias
 *
 * `var OBJECT = Object; ({}) instanceof OBJECT` is `({}) instanceof Object`, but
 * the RHS identifier is not spelled with the builtin's name, so the whole
 * builtin dispatch (`tryStaticInstanceOf` / `nativeBuiltinInstanceOfTypeIdxs`)
 * was skipped and the call fell through to the host predicate. The alias is
 * resolved from the RHS's static type: a builtin constructor's lib.d.ts type is
 * the nominal interface `XConstructor` (`ObjectConstructor`, `FunctionConstructor`,
 * …), which a user function's `typeof F` type can never be.
 *
 * ## Not covered (deliberate)
 *
 * `obj instanceof FACTORY` where `FACTORY` is a runtime-built `Function(…)`
 * value (the `S15.3.5.3_A2_*` / `_A3_*` family) needs a RUNTIME read of
 * `FACTORY.prototype` off an arbitrary callable, which the standalone object
 * model does not expose yet (`$Object.$proto` is only seeded for #2660-approved
 * fnctor reconstructions). Those keep the host import and stay refused under
 * standalone rather than being answered wrongly.
 *
 * ## Why this cannot regress a passing test
 *
 * Both branches run ONLY under `noJsHost`, on a path that ALWAYS emitted
 * `env::__instanceof_check`. A leaking module cannot instantiate, so every test
 * reaching this code already fails: a native answer can only CONVERT a failing
 * test, never turn a passing one into a failure. The JS-host lane never enters
 * this module and stays byte-identical.
 */
import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { emitThrowTypeError, noJsHost } from "./js-errors.js";
import { compileExpression } from "./shared.js";
import { isBuiltinTypeName } from "./builtin-tags.js";

/**
 * Resolve `rhs` to the NAME of the builtin constructor it holds, when its static
 * type is that builtin's lib.d.ts constructor interface (`ObjectConstructor` →
 * `"Object"`). Returns `undefined` for every other shape.
 *
 * Restricted to a bare identifier RHS: the caller's builtin dispatch compiles
 * only the LHS, so redirecting an RHS that could have side effects would drop
 * them. An identifier read has none.
 */
export function resolveBuiltinCtorAliasName(
  ctx: CodegenContext,
  rhs: ts.Expression,
  currentName: string | undefined,
): string | undefined {
  // Host-free only, and never over a name that ALREADY resolved to a builtin —
  // the gc/host lane keeps its runtime predicate byte-identically.
  if (!noJsHost(ctx)) return undefined;
  if (currentName !== undefined && isBuiltinTypeName(currentName)) return undefined;
  if (!ts.isIdentifier(rhs)) return undefined;
  // A builtin constructor's lib.d.ts type is the nominal interface
  // `XConstructor`; a union declines (a constituent could be something else at
  // the call site).
  if (ctx.oracle.typeFactOf(rhs).kind === "union") return undefined;
  const symName = ctx.oracle.declaredNameOf(rhs);
  if (symName === undefined || !symName.endsWith("Constructor")) return undefined;
  const builtin = symName.slice(0, -"Constructor".length);
  return isBuiltinTypeName(builtin) ? builtin : undefined;
}

/**
 * §7.3.20 step 1 — emit the unconditional TypeError for a RHS the checker proves
 * is a non-callable object. Evaluates both operands first (§13.10.1) and
 * discards them, then throws. Returns the (unreachable) i32 result type, or
 * `null` to decline.
 */
export function tryEmitNonCallableRhsThrow(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
): ValType | null {
  if (!noJsHost(ctx)) return null;
  // (#4484 A) §13.10.2 consults @@hasInstance at step 2 and only reaches the
  // IsCallable throw at step 5. "Not callable" is therefore NOT sufficient to
  // throw: a non-callable object carrying a CALLABLE @@hasInstance is a legal
  // `instanceof` RHS whose handler decides the answer. See the predicate below.
  if (moduleInstallsCallableHasInstance(expr.getSourceFile())) return null;
  if (!isProvablyNonCallableObjectType(ctx, expr.right)) return null;
  const lt = compileExpression(ctx, fctx, expr.left);
  if (lt) fctx.body.push({ op: "drop" });
  const rt = compileExpression(ctx, fctx, expr.right);
  if (rt) fctx.body.push({ op: "drop" });
  emitThrowTypeError(ctx, fctx, "Right-hand side of 'instanceof' is not callable");
  return { kind: "i32" };
}

/**
 * (#4484 A) Does this module install a possibly-CALLABLE `@@hasInstance` anywhere?
 *
 * ## Why the whole module, and why this gate exists at all
 *
 * §13.10.2 InstanceofOperator orders its checks: step 2 does
 * `GetMethod(C, @@hasInstance)`, step 4 CALLS that handler if it is not
 * undefined, and only step 5 throws for `IsCallable(C) === false`. So the
 * static "this RHS is a non-callable object" proof answers the WRONG question
 * on its own — `var F = {}; F[Symbol.hasInstance] = function () { … };
 * 0 instanceof F` must call the handler, not throw.
 *
 * Measured on this branch (`language/expressions/instanceof/`, standalone):
 * `symbol-hasinstance-to-boolean.js` went from a wrong VALUE to a wrong THROW
 * (`TypeError: Right-hand side of 'instanceof' is not callable`) when the
 * step-1 arm was reordered ahead of the primitive-LHS fold. Both spellings fail
 * the test, so a pass/fail sweep cannot see the difference — but a wrong throw
 * is CATCHABLE and therefore observable, which is exactly the failure class the
 * reassigned-binding guards in this issue exist to prevent. Absent-not-wrong:
 * decline and let the runtime path answer.
 *
 * ## Why module-scope and not the RHS expression
 *
 * The handler is installed by MUTATION on an arbitrary object value
 * (`F[Symbol.hasInstance] = …`), which no static type of the RHS records. There
 * is no expression-local fact to consult, so the only sound question is whether
 * the module contains such an installation at all. Modules that never mention
 * `@@hasInstance` — effectively all of them — keep the arm.
 *
 * ## Why a `null`/`undefined` value still throws
 *
 * `GetMethod` maps a `null` or `undefined` property value to `undefined`, so
 * step 4 is skipped and step 5's TypeError is exactly right. That is
 * `symbol-hasinstance-not-callable.js` (`F[Symbol.hasInstance] = null`), which
 * this issue flips to pass; excluding it here would give the row back for no
 * correctness gain. Every other value — a function, an identifier, a call
 * result — is treated as possibly callable.
 */
const HAS_INSTANCE_INSTALL_CACHE = new WeakMap<ts.SourceFile, boolean>();

function moduleInstallsCallableHasInstance(file: ts.SourceFile): boolean {
  const cached = HAS_INSTANCE_INSTALL_CACHE.get(file);
  if (cached !== undefined) return cached;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    // `X[Symbol.hasInstance] = <value>`
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(node.left) &&
      isSymbolHasInstanceKey(node.left.argumentExpression) &&
      !isDefinitelyNotCallableValue(node.right)
    ) {
      found = true;
      return;
    }
    // `{ [Symbol.hasInstance]: <value> }` and `static [Symbol.hasInstance]() {}`
    if (
      (ts.isPropertyAssignment(node) || ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)) &&
      ts.isComputedPropertyName(node.name) &&
      isSymbolHasInstanceKey(node.name.expression)
    ) {
      const value = ts.isPropertyAssignment(node)
        ? node.initializer
        : ts.isPropertyDeclaration(node)
          ? node.initializer
          : undefined;
      if (value === undefined || !isDefinitelyNotCallableValue(value)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  HAS_INSTANCE_INSTALL_CACHE.set(file, found);
  return found;
}

/** Is `key` the well-known symbol reference `Symbol.hasInstance`? */
function isSymbolHasInstanceKey(key: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(key) &&
    ts.isIdentifier(key.expression) &&
    key.expression.text === "Symbol" &&
    key.name.text === "hasInstance"
  );
}

/**
 * True only for values `GetMethod` turns into `undefined` — i.e. the handler is
 * NOT installed and §13.10.2 falls through to the step-5 IsCallable throw.
 * Everything else declines conservatively.
 */
function isDefinitelyNotCallableValue(value: ts.Expression): boolean {
  return value.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(value) && value.text === "undefined");
}

/**
 * (#4484 A) The builtin NAMESPACE objects — the same set `tryNamespaceNonCallable`
 * (calls-guards.ts) refuses to call. They are ordinary objects with no [[Call]],
 * so §13.10.2 step 4 makes `x instanceof Math` a TypeError.
 *
 * They do not reach `isProvablyNonCallableObjectType`: the oracle classifies each
 * as `builtin`, which that predicate deliberately declines (it covers `Function`,
 * a callable with no signature of its own). Naming them explicitly keeps that
 * conservatism intact while answering the one shape the spec fixes.
 * `Proxy` is deliberately ABSENT — it has [[Construct]], so it is a valid
 * `instanceof` RHS even though it cannot be called.
 */
const NAMESPACE_NON_CALLABLE_RHS: ReadonlySet<string> = new Set(["Math", "JSON", "Reflect", "Atomics"]);

/**
 * True when `expr`'s static type is an OBJECT type with neither a call nor a
 * construct signature — i.e. provably `IsCallable(…) === false` while still
 * being an object.
 *
 * Conservative by construction: `any` / `unknown` / a type parameter / a union
 * or intersection / anything carrying a primitive flag all decline, because the
 * value could be callable at runtime and a spurious throw would be a WRONG
 * answer rather than a missed conversion.
 */
function isProvablyNonCallableObjectType(ctx: CodegenContext, expr: ts.Expression): boolean {
  // (#4484 A) A bare, unshadowed builtin namespace identifier. Checked before
  // the oracle facts below, which classify it as `builtin` and decline. Unwrapped
  // through casts/parens: TypeScript rejects a bare `1 instanceof Math`, so every
  // TS-lane spelling of this shape carries an `as any`.
  {
    let rhs: ts.Expression = expr;
    while (
      ts.isParenthesizedExpression(rhs) ||
      ts.isAsExpression(rhs) ||
      ts.isNonNullExpression(rhs) ||
      ts.isTypeAssertionExpression(rhs)
    ) {
      rhs = rhs.expression;
    }
    if (
      ts.isIdentifier(rhs) &&
      NAMESPACE_NON_CALLABLE_RHS.has(rhs.text) &&
      (ctx.oracle.valueDeclarationOf(rhs)?.getSourceFile().isDeclarationFile ?? true)
    ) {
      return true;
    }
  }
  // Untyped JS infers `any` for `var o = new F()`, which the flag test below
  // rejects. §13.3.5 EvaluateNew nonetheless guarantees the value is the freshly
  // created ORDINARY object — hence not callable — as long as `F` never returns
  // a value of its own (a constructor MAY `return function(){}`). That is the
  // `__my__funct instanceof __my__funct` shape of `S11.8.6_A6_T4`.
  if (isFreshOrdinaryObjectExpression(ctx, expr)) return true;
  // `ctx.oracle` reports `function` for EXACTLY the types carrying a call or
  // construct signature, and `builtin` for the lib.d.ts nominal interfaces —
  // including `Function`, which models a callable with NO signature of its own
  // (only `apply`/`call`/`bind`). So the two admitted kinds below are precisely
  // "an object type the checker proves has no way to be called": `object` (an
  // anonymous shape) and `class` (a named non-callable interface / class
  // instance). Everything else — `any`, `unknown`, `union`, every primitive,
  // `function`, `builtin`, `unresolvable` — declines, because a spurious throw
  // is a WRONG answer, not a missed conversion.
  const fact = ctx.oracle.typeFactOf(expr);
  if (fact.kind !== "object" && fact.kind !== "class") return false;
  // Belt-and-braces: a constructor interface that happened to be modelled
  // without signatures would classify as `class` but IS callable.
  const symName = ctx.oracle.declaredNameOf(expr);
  return symName === undefined || !symName.endsWith("Constructor");
}

/**
 * True when `expr` provably holds a FRESH ORDINARY object — an object-literal,
 * or a `new F(…)` (directly or through a single-assignment binding) whose `F` is
 * a user function that never returns a value.
 *
 * Both conditions are load-bearing:
 *  - a constructor with `return <expr>` may hand back a FUNCTION (§13.3.5 keeps
 *    an object return value), which would be callable, and
 *  - a reassigned binding could hold anything at the call site.
 * Either one unproven ⇒ decline, because the consequence of a false positive is
 * a spurious TypeError (a wrong answer), not a missed conversion.
 */
function isFreshOrdinaryObjectExpression(ctx: CodegenContext, expr: ts.Expression): boolean {
  if (ts.isObjectLiteralExpression(expr)) return true;
  let source: ts.Expression = expr;
  if (ts.isIdentifier(expr)) {
    const decl = ctx.oracle.valueDeclarationOf(expr);
    if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return false;
    if (identifierIsWrittenTo(expr.getSourceFile(), expr.text)) return false;
    source = decl.initializer;
  }
  if (ts.isObjectLiteralExpression(source)) return true;
  if (!ts.isNewExpression(source) || !ts.isIdentifier(source.expression)) return false;
  const ctorDecl = ctx.oracle.valueDeclarationOf(source.expression);
  const body = resolveUserFunctionBody(ctorDecl);
  return body !== undefined && !containsValueReturn(body);
}

/** The body of a plain user function declaration / `var F = function(){}`, if any. */
function resolveUserFunctionBody(decl: ts.Declaration | undefined): ts.Block | undefined {
  if (!decl) return undefined;
  if (ts.isFunctionDeclaration(decl)) return decl.body;
  if (ts.isVariableDeclaration(decl) && decl.initializer && ts.isFunctionExpression(decl.initializer)) {
    return decl.initializer.body;
  }
  return undefined;
}

/** True when `body` contains a `return <expression>` outside any nested function. */
function containsValueReturn(body: ts.Block): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return;
    if (ts.isReturnStatement(node) && node.expression !== undefined) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return found;
}

/**
 * True when `name` is the target of any write (assignment / update) in `file` —
 * i.e. the binding is NOT single-assignment and its value at a later use site is
 * not determined by its initializer. Shared with the `isPrototypeOf` folds.
 */
export function identifierIsWrittenTo(file: ts.SourceFile, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isBinaryExpression(node) &&
      ts.isIdentifier(node.left) &&
      node.left.text === name &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      found = true;
      return;
    }
    if (
      (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) &&
      ts.isIdentifier(node.operand) &&
      node.operand.text === name
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}
