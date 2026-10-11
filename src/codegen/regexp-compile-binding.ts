// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster B, slice B8) Annex B §B.2.4.1 `RegExp.prototype.compile`
 * REPLACES a RegExp's [[OriginalSource]], [[OriginalFlags]] and matcher in
 * place. A binding whose initializer is a literal (`var subject = /a/g`) is
 * therefore not a compile-time fact about the value once anything calls
 * `subject.compile(…)`:
 *
 * ```js
 * var subject = /a/g;
 * subject.compile('a', 'i');
 * subject.lastIndex = 1;
 * subject.test('A');          // true — no `g` any more, lastIndex is ignored
 * ```
 *
 * `staticRegExpFlags` read the literal's flags through the binding and the
 * `.test` lane kept honouring `g` (`annexB/…/compile/flags-to-string`). A
 * `compile` receiver binding now answers "flags unknown", so `lastIndex`
 * handling reads the runtime flags on the carrier. Deliberately NOT applied to
 * `isTrustedBackendCreatedRegExpBinding`: declining the whole binding there
 * lost `toString()`/`source` on six other `compile/*` rows (measured).
 * Syntactic and per-file: any `<ident>.compile(` whose identifier resolves to
 * the same declaration.
 */
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";

/** Per file: every `<ident>.compile(…)` receiver identifier node. */
const receiversByFile = new WeakMap<ts.SourceFile, ts.Identifier[]>();

function compileReceivers(sf: ts.SourceFile): ts.Identifier[] {
  const cached = receiversByFile.get(sf);
  if (cached !== undefined) return cached;
  const found: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "compile" &&
      ts.isIdentifier(node.expression.expression)
    ) {
      found.push(node.expression.expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  receiversByFile.set(sf, found);
  return found;
}

/** Is `expr` an identifier whose binding some `.compile(…)` call receives? */
export function compiledRegExpBinding(ctx: CodegenContext, expr: ts.Expression): boolean {
  let e = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (!ts.isIdentifier(e)) return false;
  const id = e;
  const sf = id.getSourceFile() as ts.SourceFile | undefined; // undefined on a synthesized node
  if (sf === undefined) return false;
  const receivers = compileReceivers(sf).filter((r) => r.text === id.text);
  if (receivers.length === 0) return false;
  const decl = ctx.oracle.valueDeclarationOf(id);
  return decl !== undefined && receivers.some((r) => ctx.oracle.valueDeclarationOf(r) === decl);
}
