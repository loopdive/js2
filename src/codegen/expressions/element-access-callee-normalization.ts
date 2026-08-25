// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4625) `x["toString"]()` — normalise a STATIC string-literal element-access
// callee onto the property-access route.
//
// ## The defect
//
// `false["toString"]()`, `new Boolean(false)["toString"]()` and
// `new Number(1)["toFixed"](5)` threw
// `TypeError: Cannot access property on null or undefined` under
// `--target standalone` while the dot spellings all answered correctly (#4619
// taught the property-access route about wrapper receivers and
// singleton-carried proto-method values). Measured on `9d9291db7`: the bracket
// call never reaches that route at all. It is claimed, several arms earlier, by
// `compileCallableElementAccessCall` (#1306) — the arm for
// `fns[i](…)` / `fns["0"](…)`, i.e. "read a CALLABLE VALUE out of the receiver,
// then invoke it".
//
// `cea` claims on a purely syntactic signal: TypeScript reports a call
// signature on the element type. For `false["toString"]` that signature comes
// from `interface Boolean` in `lib.es5.d.ts`, so the test passes — but the
// premise behind it does not hold. The compiler materialises no first-class
// closure in the element slot of a primitive or a wrapper object, so the
// element read yields null and `cea`'s own `emitNullCheckThrow` fires. The
// value being "read" is a built-in method that only exists as a lowering.
//
// ## The condition, and why it is the RECEIVER-independent one
//
// Route to the property-access spelling exactly when the member is
// **ambient/lib-declared** — every declaration of the resolved symbol lives in
// a `.d.ts`. That is the precise complement of `cea`'s premise:
//
//   - a lib-declared member (`toString`, `toFixed`, `getTime`, `call`) is NEVER
//     a user closure parked in a slot, so "read the value and call it" is a
//     fiction and the method-call route is the only correct lowering;
//   - a user-authored callable element (`fns[0]`, an object literal's `m`, a
//     class field holding an arrow) has a declaration in the user's own file,
//     declines here, and keeps `cea` byte-for-byte.
//
// Deliberately NOT conditioned on the receiver: asking "is this a Boolean
// wrapper?" would re-derive, at a second site, the receiver knowledge #4619
// and #4481 put on the property-access route — which is the copy this issue
// exists to avoid. The rewrite hands the whole question to that one route.
//
// ## Placement (it is load-bearing)
//
// Immediately BEFORE the `cea` arm and AFTER every arm that already lowers a
// bracket call correctly (iterator/RegExp symbol protocols, class and struct
// methods, static methods, `string_*`, the number-method family,
// `compileArrayMethodCall`). Those arms are the reason `(1)["toString"]()`,
// `s["charAt"](0)`, `a["join"]("-")` and `a[0]()` pass today, and they run
// before this one, so their bytes cannot move. Numeric and computed keys never
// satisfy the identifier-shape test below, so the array/vec element-call
// shapes are byte-stable by construction rather than by review.
//
// The rewrite itself follows the precedent already in `call-tail-dispatch.ts`:
// the `ctx.nativeStrings` string-method arm (#3027) recompiles the call as the
// equivalent dot form rather than duplicating the dot form's logic. Same move,
// one canonical entry.
//
// ## Spec note
//
// §13.3.3 evaluates `x["k"]` as ToPropertyKey of the key expression. For a
// string literal that is the string itself, so `x["k"]()` and `x.k()` are the
// same MemberExpression evaluation with the same evaluation order — the key
// literal has no side effects and no coercion to observe. Non-identifier keys
// (`x["a b"]()`) cannot be spelled as a property access and keep the element
// chain.
import { ts } from "../../ts-api.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import type { InnerResult } from "../shared.js";

/** ES5 IdentifierName shape, ASCII subset — what `x.<key>` can spell. */
const IDENTIFIER_SHAPED = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * True when every declaration of the member the key names lives in a
 * declaration file, i.e. the member is a built-in / ambient one and cannot be a
 * user closure stored in the slot. An unresolved member (no declarations)
 * answers false: absent-not-wrong, the element chain keeps it.
 *
 * The question is asked of the KEY LITERAL, not of the element access. TS
 * resolves a string-literal index to the property symbol at the literal node;
 * `getSymbolAtLocation` on the `ElementAccessExpression` itself answers nothing
 * (measured: `[]` for both `false["toString"]` and `o["m"]`, so it cannot tell
 * the two apart). At the literal the split is exact — `lib.d.ts` for
 * `toString`, the user's own file for `o.m`.
 */
function memberIsAmbientDeclared(ctx: CodegenContext, key: ts.StringLiteral): boolean {
  const decls = ctx.oracle.declarationsOf(key);
  if (decls.length === 0) return false;
  return decls.every((d) => d.getSourceFile().isDeclarationFile);
}

/**
 * Rewrite `recv["key"](args)` to `recv.key(args)` and recompile, for a static
 * identifier-shaped string-literal key naming an ambient member. Returns
 * `undefined` when the shape or the member does not qualify, leaving the
 * caller's existing element-access chain untouched.
 *
 * `recompile` is threaded in rather than imported so this module does not
 * depend on `./calls.js`.
 */
export function tryNormalizeStaticStringElementCallee(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  elemAccess: ts.ElementAccessExpression,
  recompile: (ctx: CodegenContext, fctx: FunctionContext, call: ts.CallExpression) => InnerResult,
): InnerResult | undefined {
  // An optional element access (`x?.["k"]()`) carries short-circuit semantics a
  // plain property access does not. Decline rather than drop them; the optional
  // forms have their own lowering (`calls-optional.ts`).
  if (elemAccess.questionDotToken || expr.questionDotToken) return undefined;
  const argExpr = elemAccess.argumentExpression;
  if (!argExpr || !ts.isStringLiteral(argExpr)) return undefined;
  if (!IDENTIFIER_SHAPED.test(argExpr.text)) return undefined;
  if (!memberIsAmbientDeclared(ctx, argExpr)) return undefined;

  const syntheticProp = ts.factory.createPropertyAccessExpression(elemAccess.expression, argExpr.text);
  ts.setTextRange(syntheticProp, elemAccess);
  (syntheticProp as unknown as { parent: ts.Node }).parent = expr;
  const syntheticCall = ts.factory.createCallExpression(syntheticProp, expr.typeArguments, expr.arguments);
  ts.setTextRange(syntheticCall, expr);
  (syntheticCall as unknown as { parent: ts.Node }).parent = expr.parent;
  return recompile(ctx, fctx, syntheticCall as ts.CallExpression);
}
