// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6460) Give an ARITY-INDEXED lowering the real argument count of a call
 * whose spread source is a named array binding.
 *
 * ## The defect
 *
 * Several lowerings pick their shape from the call site's arity: the native
 * construct drivers are minted one per arity (`native-construct.ts`), the
 * fnctor `new` path pushes one operand per declared parameter
 * (`fnctor-constructor-identity.ts`), and the closure `call_ref` path binds
 * formals positionally (`call-identifier.ts`). A `SpreadElement` has no static
 * arity, so all three ask `flattenCallArgs`, which only understands an INLINE
 * array literal (`f(...[1, 2])`). For every other spelling they fall through
 * to `compileExpressionInner`'s last resort, which compiles a `SpreadElement`
 * as its own inner expression — i.e. the ARRAY is passed as ONE argument.
 *
 * Measured standalone, host-free, before this module existed:
 *
 * | source                                            | answer           |
 * | ------------------------------------------------- | ---------------- |
 * | `function C(a,b,c){…}; const a=[1,2,3]; new C(...a)` | `1,2,3` + 2 × `undefined` |
 * | `const g=f; const a=[1,2,3]; g(...a)`             | same             |
 * | `const a=[1,1,1]; new Temporal.Duration(...a)`    | **`null`** (no driver for an unknown arity) |
 *
 * The third row is the one that costs conformance: every
 * `built-ins/Temporal/Duration/*-undefined.js` row writes
 * `const args = [1, 1, 1]; new Temporal.Duration(...args)` and then reads
 * `duration.years`, which is where the corpus reports
 * `Cannot access property on null or undefined`.
 *
 * ## What is safe to expand, and why the rule is this narrow
 *
 * Expanding `...xs` into `xs`'s ELEMENT EXPRESSIONS moves those expressions
 * from the array-literal site to the call site. That is only sound when
 * re-evaluating them cannot be observed and when the array's length cannot
 * have changed in between, so this module demands all four of:
 *
 *   1. the spread source is an identifier bound by a **`const`** declaration
 *      whose initializer is an array literal with no holes and no nested
 *      spread — so the LENGTH is syntactic;
 *   2. every element is a **re-evaluable literal** (number / string / bigint /
 *      `true` / `false` / `null` / `undefined` / a negated numeric literal) —
 *      so moving the evaluation is unobservable;
 *   3. **every** reference to the binding in its whole source file is itself a
 *      spread operand — no aliasing, no `xs[i] = …`, no `xs.push(…)`, no
 *      argument position through which a callee could mutate it. This is the
 *      check that makes (1) hold at the call site and not merely at the
 *      declaration;
 *   4. the binding is declared in the same source file as the call (a module
 *      import could be re-exported from a mutating module).
 *
 * Rule 3 is deliberately stricter than "is not assigned": a `const` array is
 * mutable through its own reference, so proving the declaration is `const`
 * proves nothing about `length`. Only proving that NO reference can reach a
 * mutator does.
 *
 * ## Lane
 *
 * Callers gate on `ctx.standalone || ctx.wasi`. The JS-host lane already
 * repairs these shapes through `emitDynamicSpreadCall` (which builds a real JS
 * argument array and calls `__call_function`), so widening the static rule
 * there would change bytes for no behavioural gain. Keeping the gate at the
 * call sites — not inside this module — keeps this module a pure predicate.
 */
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";

/** An element that can be re-evaluated at a different program point safely. */
function isReEvaluableLiteral(element: ts.Expression): boolean {
  if (ts.isNumericLiteral(element) || ts.isStringLiteral(element) || ts.isBigIntLiteral(element)) return true;
  if (element.kind === ts.SyntaxKind.TrueKeyword || element.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (element.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isIdentifier(element) && element.text === "undefined") return true;
  if (ts.isPrefixUnaryExpression(element)) {
    const { operator, operand } = element;
    if (
      (operator === ts.SyntaxKind.MinusToken || operator === ts.SyntaxKind.PlusToken) &&
      ts.isNumericLiteral(operand)
    ) {
      return true;
    }
  }
  return false;
}

/** The array literal a spread source names, when rules 1, 2 and 4 all hold. */
function constArrayLiteralFor(
  ctx: CodegenContext,
  identifier: ts.Identifier,
): { readonly declaration: ts.VariableDeclaration; readonly literal: ts.ArrayLiteralExpression } | undefined {
  const symbol = ctx.checker.getSymbolAtLocation(identifier);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!declaration || !ts.isVariableDeclaration(declaration)) return undefined;
  if (declaration.getSourceFile() !== identifier.getSourceFile()) return undefined;
  const list = declaration.parent;
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) return undefined;
  const initializer = declaration.initializer;
  if (!initializer || !ts.isArrayLiteralExpression(initializer)) return undefined;
  for (const element of initializer.elements) {
    if (ts.isOmittedExpression(element) || ts.isSpreadElement(element)) return undefined;
    if (!isReEvaluableLiteral(element)) return undefined;
  }
  return { declaration, literal: initializer };
}

/**
 * Rule 3: every identifier in the file that resolves to `declaration` is the
 * declaration's own name or the operand of a spread. Any other occurrence —
 * an argument, an element write, a member call — could change `length`.
 */
function onlyEverSpread(ctx: CodegenContext, declaration: ts.VariableDeclaration): boolean {
  const name = declaration.name;
  if (!ts.isIdentifier(name)) return false;
  const target = ctx.checker.getSymbolAtLocation(name);
  if (!target) return false;
  let clean = true;
  const visit = (node: ts.Node): void => {
    if (!clean) return;
    if (ts.isIdentifier(node) && node.text === name.text) {
      if (node !== name && ctx.checker.getSymbolAtLocation(node) === target) {
        const parent = node.parent;
        if (!parent || !ts.isSpreadElement(parent) || parent.expression !== node) clean = false;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration.getSourceFile());
  return clean;
}

/**
 * Flatten `args` when every spread in it has a statically-known element list.
 *
 * Returns `undefined` when nothing can be flattened, so a caller can keep its
 * existing behaviour with a single `??`. A list with no spread at all also
 * returns `undefined` — there is nothing to repair and the caller's own
 * fast path must stay byte-identical.
 */
export function resolveStaticSpreadArgs(
  ctx: CodegenContext,
  args: readonly ts.Expression[],
): ts.Expression[] | undefined {
  if (!args.some((argument) => ts.isSpreadElement(argument))) return undefined;
  const flat: ts.Expression[] = [];
  for (const argument of args) {
    if (!ts.isSpreadElement(argument)) {
      flat.push(argument);
      continue;
    }
    const source = argument.expression;
    if (ts.isArrayLiteralExpression(source)) {
      for (const element of source.elements) {
        if (ts.isOmittedExpression(element) || ts.isSpreadElement(element)) return undefined;
        flat.push(element);
      }
      continue;
    }
    if (!ts.isIdentifier(source)) return undefined;
    const bound = constArrayLiteralFor(ctx, source);
    if (!bound || !onlyEverSpread(ctx, bound.declaration)) return undefined;
    for (const element of bound.literal.elements) flat.push(element as ts.Expression);
  }
  return flat;
}
