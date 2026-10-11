// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#2818 / #6651 C2-b) The scope-local variable names a statement list
 * declares, for the class-capture deferral decision in `declarations.ts`.
 *
 * `var` is collected alongside `let` / `const`. The original rule took only the
 * block-scoped forms, on the premise that "a `var` is function-scoped and, when
 * referenced by a class method, is already hoisted to a module global". That
 * premise holds at MODULE scope and nowhere else — and the caller reaches this
 * function only with a non-null accumulator, i.e. from INSIDE a function body,
 * which is precisely where it does not hold. A `var` declared in a function is
 * an ordinary function LOCAL, so a class declared in a block of that function
 * and capturing it hit the very ordering bug #2818 exists to fix: the class
 * compiled eagerly, `promoteAccessorCapturesToGlobals` never fired, and the
 * method body wrote a FRESH local of the same name that nothing ever reads.
 *
 * Measured on the branch base (`.tmp/w6651C/q31.ts`, ten lines, no `super`,
 * standalone):
 *
 * ```
 * function test() { var n = 0;
 *   if (1) { class C { m() { n = 5; } } new C().m(); }
 *   return n; }                          // base 0, node 5
 * ```
 *
 * The emitted `$C_m` declares `(local $n f64)` and stores into it; with the
 * same class at function-body level (always deferred) the method stores into
 * the promoted `__captured_n` global and the row answers 5. The block is the
 * whole difference, a `let` in that shape already worked, and a function
 * expression / object-literal method in the same block already worked too — the
 * class method was the only one of the three that was broken.
 *
 * Nothing new is deferred at module scope (the accumulator is `null` there, so
 * this is not called), and a name that genuinely IS a module global is still
 * filtered out by the caller's `wouldPromote` check, so the deferral fires only
 * where the promotion channel would.
 *
 * Does not descend into nested blocks or function bodies: the caller
 * accumulates one level per statement list as it recurses.
 */
import { ts } from "../ts-api.js";
import { collectBindingPatternNames } from "./closures.js";

export function collectScopeLocalDeclNames(
  stmts: ts.NodeArray<ts.Statement> | readonly ts.Statement[],
  out: Set<string>,
): void {
  for (const stmt of stmts) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name)) {
        out.add(decl.name.text);
      } else if (ts.isObjectBindingPattern(decl.name) || ts.isArrayBindingPattern(decl.name)) {
        collectBindingPatternNames(decl.name, out);
      }
    }
  }
}
