// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4491 T3) Resolve an `instanceof` RHS that holds a builtin constructor only
 * because an ASSIGNMENT put it there.
 *
 * ## What `resolveBuiltinCtorAliasName` cannot see
 *
 * `native-ordinary-instanceof.ts` already resolves the DECLARED alias —
 * `var OBJECT = Object; ({}) instanceof OBJECT` — from the binding's static
 * type, whose lib.d.ts shape is the nominal `ObjectConstructor`. Measured on
 * this branch, `--target standalone`:
 *
 * | spelling                                             | answer |
 * | ---------------------------------------------------- | ------ |
 * | `var C = Object; o instanceof C`                      | `true` ✓ |
 * | `var OBJECT = 0; OBJECT = Object; o instanceof OBJECT`| `false` ✗ |
 * | `OBJECT = Object; o instanceof OBJECT` (no `var`)     | `false` ✗ |
 *
 * Row two declines because the checker types the binding as the UNION
 * `number | ObjectConstructor`, and the alias resolver rejects unions on
 * purpose (a constituent could be something else at the use site). Row three
 * declines because an implicit global has no declaration to read a type from
 * at all. Both are `language/expressions/instanceof/S11.8.6_A2.4_T{1,4}`.
 *
 * ## The fact this adds, and why it is sound
 *
 * Not "what type does the checker give the binding", but "what values does this
 * FILE ever put in it". When every value ever written to the spelling is the
 * SAME builtin constructor, then at every point where the name reads without
 * throwing it holds that constructor — a read before the first write is an
 * unresolvable reference and throws ReferenceError, which is a different
 * outcome the caller never reaches. So folding `x instanceof NAME` to
 * `x instanceof <builtin>` is correct on every execution that produces an
 * answer at all.
 *
 * That is strictly weaker than row two above, which this therefore does NOT
 * resolve: `var OBJECT = 0` contributes a second, non-constructor source, so
 * the spelling is not uniform and the predicate declines. Fixing that one needs
 * a runtime read of the RHS value, not a static fold.
 *
 * ## Conservatism — every uncertainty answers `undefined`
 *
 * The spelling is disqualified by: a compound assignment or `++`/`--`; a
 * parameter, catch clause, binding element or `for (x in …)` loop variable; a
 * function or class declaration; a `var`/`let`/`const` declaration WITHOUT an
 * initializer (it can be assigned later through a path not spelled `NAME =`);
 * a `delete`; any assignment whose RHS is not a bare identifier; or two sources
 * naming different builtins. A false `undefined` costs a missed conversion; a
 * false answer would be a WRONG `true`, which is the direction this must never
 * take.
 *
 * Host-free only. The gc/host lane keeps its runtime `__instanceof` predicate
 * byte-identically.
 */
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import { isBuiltinTypeName } from "./builtin-tags.js";
import { noJsHost } from "./js-errors.js";

/** `undefined` = not yet scanned; `null` = scanned and disqualified. */
type SpellingSources = Map<string, string | null>;

const CACHE = new WeakMap<ts.SourceFile, SpellingSources>();

/** Strip the wrappers that are transparent around an assignment target/value. */
function unwrap(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isNonNullExpression(cur) ||
    ts.isTypeAssertionExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

/**
 * The builtin constructor `expr` names, when it is a bare identifier whose
 * declared type is that builtin's lib.d.ts `XConstructor` interface. Same proof
 * `resolveBuiltinCtorAliasName` uses — a user function's `typeof F` type can
 * never be a nominal `…Constructor`.
 */
function builtinCtorNameOf(ctx: CodegenContext, expr: ts.Expression): string | undefined {
  const e = unwrap(expr);
  if (!ts.isIdentifier(e)) return undefined;
  if (ctx.oracle.typeFactOf(e).kind === "union") return undefined;
  const symName = ctx.oracle.declaredNameOf(e);
  if (symName === undefined || !symName.endsWith("Constructor")) return undefined;
  const builtin = symName.slice(0, -"Constructor".length);
  return isBuiltinTypeName(builtin) ? builtin : undefined;
}

/**
 * One walk per source file: for every spelling, the single builtin every write
 * to it supplies, or `null` when the spelling is disqualified.
 */
function scanFile(ctx: CodegenContext, sourceFile: ts.SourceFile): SpellingSources {
  const cached = CACHE.get(sourceFile);
  if (cached !== undefined) return cached;
  const out: SpellingSources = new Map();
  const disqualify = (name: string): void => {
    out.set(name, null);
  };
  const contribute = (name: string, value: ts.Expression): void => {
    if (out.get(name) === null) return;
    const builtin = builtinCtorNameOf(ctx, value);
    if (builtin === undefined) {
      disqualify(name);
      return;
    }
    const existing = out.get(name);
    if (existing === undefined) out.set(name, builtin);
    else if (existing !== builtin) disqualify(name);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && ts.isIdentifier(unwrap(node.left))) {
      const name = (unwrap(node.left) as ts.Identifier).text;
      const op = node.operatorToken.kind;
      if (op === ts.SyntaxKind.EqualsToken) contribute(name, node.right);
      else if (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment) disqualify(name);
    }
    if (
      (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) &&
      ts.isIdentifier(node.operand) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      disqualify(node.operand.text);
    }
    if (ts.isDeleteExpression(node) && ts.isIdentifier(unwrap(node.expression))) {
      disqualify((unwrap(node.expression) as ts.Identifier).text);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      // A declaration WITHOUT an initializer leaves a hole this scan cannot
      // account for, so it disqualifies rather than contributing nothing.
      if (node.initializer === undefined) disqualify(node.name.text);
      else contribute(node.name.text, node.initializer);
    }
    if ((ts.isParameter(node) || ts.isBindingElement(node)) && ts.isIdentifier(node.name)) {
      disqualify(node.name.text);
    }
    if (node.kind === ts.SyntaxKind.CatchClause) {
      const vd = (node as ts.CatchClause).variableDeclaration;
      if (vd && ts.isIdentifier(vd.name)) disqualify(vd.name.text);
    }
    if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && ts.isIdentifier(node.initializer)) {
      disqualify(node.initializer.text);
    }
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name !== undefined) {
      disqualify(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  CACHE.set(sourceFile, out);
  return out;
}

/**
 * The builtin constructor `rhs` provably holds, when every write to its
 * spelling in this file assigns that same builtin. `undefined` otherwise.
 *
 * `currentName` is the name the caller's own resolution already produced;
 * a name that ALREADY resolves to a builtin is left alone so no existing
 * dispatch changes.
 */
export function resolveBuiltinCtorAssignedAliasName(
  ctx: CodegenContext,
  rhs: ts.Expression,
  currentName: string | undefined,
): string | undefined {
  if (!noJsHost(ctx)) return undefined;
  if (currentName !== undefined && isBuiltinTypeName(currentName)) return undefined;
  if (!ts.isIdentifier(rhs)) return undefined;
  // A LOCAL binding of this spelling is a different value entirely; the scan is
  // per-file and per-spelling, so only names the file writes exactly once as a
  // builtin survive it anyway — but a declared local would have contributed its
  // own initializer (or disqualified the spelling) above.
  return scanFile(ctx, rhs.getSourceFile()).get(rhs.text) ?? undefined;
}
