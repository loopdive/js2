// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4189) Module-global representation widening for string-typed `var`s that
 * are re-assigned from a sloppy implicit global.
 *
 * The Sputnik scope-chain family (`S12.10_A3.*_T2..T5` and siblings) uses the
 * idiom
 *
 *   this.p1 = 1;               // implicit global — bare `p1` reads resolve it
 *   var result = "result";     // checker types `result` as string
 *   try { … } catch (e) { result = p1; }
 *   if (result !== 1) { throw new Test262Error('…' + result); }
 *
 * `result`'s TS type is `string`, so the module global is monomorphized to the
 * native-string representation. But `p1` is an implicit-global read — an
 * `externref` carrying ANY dynamic value. Storing it through the string-typed
 * global runs an extract-string-else-null coercion (standalone: the number 1
 * becomes a NULL string ref; host lane: it is ToString'd), and the later
 * `result !== 1` is constant-folded to `true` by the sound-per-representation
 * "string ref vs numeric primitive are never strictly equal" arm in
 * binary-ops-typed-dispatch.ts. Net effect: the VALUE is right, the verdict is
 * wrong, and on standalone the failure surfaces as a null-deref inside
 * `__str_concat` while rendering the error message.
 *
 * Both downstream sites are correct GIVEN the representation invariant "this
 * global only ever holds a string" — the bug is committing to that invariant
 * while the program visibly re-assigns the var from an `any`-carrying source.
 * The fix is representational: when a module-level string-typed `var` receives
 * a plain `=` assignment whose RHS is a bare identifier naming a sloppy
 * implicit global (the `recordSloppyImplicitGlobalNames` + #3956 `this.p = v`
 * pre-scan — populated by `recordSourceGlobalEnvironment` BEFORE declaration
 * collection), widen its wasm global to `externref`. Every consumer of an
 * externref-holding-string already exists (it is exactly how the implicit
 * global `p1` itself is read, compared, and concatenated).
 *
 * Deliberately NARROW (measured on the 11-file `S12.10_A3.*` cluster, both
 * lanes): only plain `=`, only a bare-identifier RHS, only implicit-global
 * names, only string-typed targets. Arbitrary `any`-typed RHS shapes (member
 * reads, calls) are excluded on purpose — widening is semantically safe but
 * changes lowering for every use of the name, and the broader predicate is
 * unsized. Extend only with a measurement.
 */
import type { TypeOracle } from "../checker/oracle.js";
import { ts } from "../ts-api.js";

/**
 * True when the resolved "declaration" of an identifier is not a real lexical
 * binding but the binder's synthesized global-property declaration — the
 * script-top-level `this.p = v` / `globalThis.p = v` / bare `p = v` assignment
 * node (a BinaryExpression, or its PropertyAccessExpression LHS in some binder
 * versions) — or nothing at all. Either way the read at runtime goes through
 * the sloppy-implicit-global path and carries an arbitrary dynamic value.
 */
function isImplicitGlobalDeclarationShape(decl: ts.Declaration | undefined): boolean {
  return decl === undefined || ts.isBinaryExpression(decl) || ts.isPropertyAccessExpression(decl);
}

/**
 * One walk of the source file: collect the module-level variable DECLARATIONS
 * (resolved through the oracle, so function-local shadows do not fire) that
 * receive `name = <implicitGlobalIdentifier>` anywhere — at any nesting depth,
 * including inside function bodies, since those assignments target the same
 * module binding at runtime.
 */
export function collectImplicitGlobalAssignedVarDecls(
  sourceFile: ts.SourceFile,
  oracle: TypeOracle,
  sloppyImplicitGlobals: ReadonlySet<string> | undefined,
): Set<ts.VariableDeclaration> {
  const out = new Set<ts.VariableDeclaration>();
  if (process.env.W11_DEBUG) {
    console.error(
      `[w11] scan: implicitGlobals=${sloppyImplicitGlobals ? [...sloppyImplicitGlobals].join(",") : "none"}`,
    );
  }
  if (!sloppyImplicitGlobals || sloppyImplicitGlobals.size === 0) return out;
  const visit = (node: ts.Node): void => {
    if (
      process.env.W11_DEBUG &&
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      ts.isIdentifier(node.right)
    ) {
      const d = oracle.valueDeclarationOf(node.right);
      console.error(
        `[w11] see ${node.left.text} = ${node.right.text}: inSet=${sloppyImplicitGlobals.has(node.right.text)} rhsDecl=${
          d
            ? `${ts.SyntaxKind[d.kind]}@${d.getSourceFile().fileName}:${d.getSourceFile().getLineAndCharacterOfPosition(d.getStart()).line + 1}`
            : "none"
        }`,
      );
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      ts.isIdentifier(node.right) &&
      sloppyImplicitGlobals.has(node.right.text) &&
      // The RHS must actually BE the implicit-global read — a real binding
      // (var/let/param/…) shadowing the name has a trustworthy static type, so
      // the string invariant holds for it. NOTE the binder DOES synthesize a
      // "declaration" for a script-top-level `this.p = v` / `p = v` — its
      // valueDeclaration is the assignment's BinaryExpression (verified on
      // `S12.10_A3.1_T2`: `p1` resolves to the `this.p1 = 1` node) — so
      // "undefined declaration" alone under-matches; an assignment-shaped
      // declaration is still the implicit global, not a shadow.
      isImplicitGlobalDeclarationShape(oracle.valueDeclarationOf(node.right))
    ) {
      const decl = oracle.variableDeclarationOf(node.left);
      if (process.env.W11_DEBUG) {
        console.error(
          `[w11] assign ${node.left.text} = ${node.right.text}: implicit-rhs=yes declOfLhs=${decl ? "yes" : "no"}`,
        );
      }
      if (decl !== undefined) out.add(decl);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}
