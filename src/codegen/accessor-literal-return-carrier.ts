// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";

/**
 * (#6614) The RETURN-SLOT twin of #5376.
 *
 * ## The wrong answer this removes
 *
 * ```js
 * const M = { mk() { return { get g() { return 5; } }; } };
 * const r = M.mk();
 * r.g;   // standalone: TypeError "Cannot access property on null or undefined"
 *        // spec / gc lane: 5
 * ```
 *
 * A literal carrying a `get`/`set` accessor is built by
 * `compileObjectLiteralWithAccessors` as a HOST object — `__new_plain_object` +
 * `__defineProperty_accessor`, an externref — never as a WasmGC struct. The
 * checker, though, types the enclosing function's return as the anonymous
 * object shape the accessor's return type implies (`{ readonly g: number }`),
 * so the RECEIVING binding is laid out as `(ref null $__anon_N)`. The store
 * guard (`ref.test $__anon_N` on the host object) always fails, `ref.null` is
 * written, and every later read is a `struct.get` on null — an uncatchable
 * trap, not a wrong value.
 *
 * `declarations.ts` already closes exactly this hole for one spelling:
 * `functionReturnsHostObjectLiteralCarrier` puts a top-level
 * `function mk() { return { get g() {…} }; }`'s return type into
 * `ctx.objectHashConsumerTypes`, which `resolveWasmType` answers `externref`
 * for. It is reached only from the two `ts.FunctionDeclaration` registration
 * sites, and only for a source-file-level declaration — so EVERY other spelling
 * of the same function fell through:
 *
 * | spelling | before |
 * | --- | --- |
 * | top-level `function mk()` | correct (the existing arm) |
 * | `const mk = function () {}` | trap |
 * | `const mk = () => {}` | trap |
 * | `{ mk() {} }` object-literal method | trap |
 * | `class C { mk() {} }` | trap |
 * | a `function` NESTED in another function | trap |
 *
 * `TemporalHelpers.toPrimitiveObserver` is the object-literal-method row, which
 * is why #5383's `infinity-throws-rangeerror.js` /
 * `overflow-wrong-type.js` families reached the getter cluster with the
 * observer's `calls` array empty and the getter never invoked.
 *
 * ## Scope
 *
 * - **Accessor literals only.** Same deliberate narrowing as #5376: the other
 *   `objectLiteralForcesHostPath` reasons (runtime computed key,
 *   `[Symbol.dispose]`, empty-string key, spread in a non-specific context)
 *   share the null-drop mechanism and are a separate, separately-measured
 *   change. The existing FunctionDeclaration arm uses the broader predicate;
 *   this pre-pass is additive, so a declaration keeps whichever arm fires.
 * - **Standalone / WASI only.** The JS-host lane represents every object as an
 *   externref already, so all six spellings above answer correctly there and
 *   its bytes must not move.
 * - Lives in its own module because `src/codegen/index.ts` — where the pre-pass
 *   is driven — cannot import `literals.ts` (index↔literals cycle), which is
 *   where `objectLiteralForcesHostPath` lives. Same reason as
 *   `accessor-value-field.ts`.
 */

/** A literal that `compileObjectLiteralWithAccessors` builds as a host object. */
function isAccessorLiteral(expr: ts.Expression): expr is ts.ObjectLiteralExpression {
  return (
    ts.isObjectLiteralExpression(expr) &&
    expr.properties.some((p) => ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p))
  );
}

function unwrapCarrier(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

type FunctionLike =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

function isFunctionLike(node: ts.Node): node is FunctionLike {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/** Any node that owns its own `return` statements — a scan boundary. */
function isOwnFunctionBoundary(node: ts.Node): boolean {
  return isFunctionLike(node) || ts.isConstructorDeclaration(node);
}

/**
 * True when `fn` hands an accessor-bearing object literal out through its
 * return slot — directly, through a local binding, or through either arm of a
 * conditional. Mirrors `declarations.ts::functionReturnsHostObjectLiteralCarrier`
 * so the two cannot disagree about what "returns a host carrier" means.
 */
function returnsAccessorLiteral(ctx: CodegenContext, fn: FunctionLike): boolean {
  const body = fn.body;
  if (!body) return false;

  const hostDeclarations = new Set<ts.VariableDeclaration>();
  const returns: ts.Expression[] = [];

  if (!ts.isBlock(body)) {
    // Concise arrow body: `() => ({ get g() {…} })` — the body IS the return.
    returns.push(body);
  } else {
    const visit = (node: ts.Node): void => {
      if (node !== body && isOwnFunctionBoundary(node)) return;
      if (ts.isVariableDeclaration(node) && node.initializer) {
        if (isAccessorLiteral(unwrapCarrier(node.initializer))) hostDeclarations.add(node);
      } else if (ts.isReturnStatement(node) && node.expression) {
        returns.push(node.expression);
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(body, visit);
  }

  const isHostCarrier = (expression: ts.Expression): boolean => {
    const current = unwrapCarrier(expression);
    if (isAccessorLiteral(current)) return true;
    if (ts.isIdentifier(current)) {
      const declaration = ctx.oracle.valueDeclarationOf(current);
      return declaration !== undefined && ts.isVariableDeclaration(declaration) && hostDeclarations.has(declaration);
    }
    if (ts.isConditionalExpression(current)) {
      return isHostCarrier(current.whenTrue) || isHostCarrier(current.whenFalse);
    }
    return false;
  };

  return returns.some(isHostCarrier);
}

/**
 * Pre-pass: record the return type of every function-like that hands out an
 * accessor-bearing object literal, so `resolveWasmType` answers `externref` for
 * that type wherever it lands (module global, local slot, struct field).
 *
 * Runs at the same deterministic point as
 * `collectDynamicObjectReturnCarrierTypes` — before `collectDeclarations`, and
 * therefore before any binding is typed or any body compiles.
 */
export function collectAccessorLiteralReturnCarrierTypes(
  ctx: CodegenContext,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): void {
  if (!ctx.standalone && !ctx.wasi) return;
  const carriers = new Set<ts.SignatureDeclaration>();
  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node) && returnsAccessorLiteral(ctx, node)) {
      carriers.add(node);
      const sig = checker.getSignatureFromDeclaration(node);
      if (sig) ctx.objectHashConsumerTypes.add(checker.getReturnTypeOfSignature(sig));
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  if (carriers.size === 0) return;

  // The declaration's return type and the type a CALL SITE resolves are not
  // always the same `ts.Type` object, and `objectHashConsumerTypes` is keyed by
  // type IDENTITY. A class method is the measured case: both print
  // `{ readonly g: any; }`, the set contains the declaration's, and the
  // binding's misses — so `const r = new C().mk()` kept the closed-struct slot
  // while `C_mk` already returned externref. Register the call-site type too,
  // the same belt-and-braces `collectDynamicObjectReturnCarrierTypes` uses for
  // its own carrier functions.
  //
  // oracle-ratchet-allow (#6614, granted in the issue frontmatter): this is a
  // raw `ts.Type`-IDENTITY question — the key of a Set that `resolveWasmType`
  // consults to pick a ValType. That is a wasm-lowering question, deliberately
  // ABOVE what `ctx.oracle`'s registry-free TypeFacts can express.
  const collectCalls = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const declaration = checker.getResolvedSignature(node)?.declaration;
      if (declaration && carriers.has(declaration as ts.SignatureDeclaration)) {
        ctx.objectHashConsumerTypes.add(checker.getTypeAtLocation(node));
      }
    }
    ts.forEachChild(node, collectCalls);
  };
  ts.forEachChild(sourceFile, collectCalls);
}
