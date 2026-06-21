// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Temporal Dead Zone (TDZ) early-error rules (#1931). Extracted verbatim from
// detectEarlyErrors; the only change is threading an EarlyErrorContext instead
// of closing over the monolith's `errors`/`pos`.
import { ts, forEachChild } from "../../ts-api.js";
import type { EarlyErrorContext } from "./context.js";

/**
 * Check for temporal dead zone (TDZ) violations in a list of statements.
 * A TDZ violation occurs when a let/const variable is referenced before
 * its declaration in the same scope.
 *
 * Handles two patterns:
 * 1. Use in a prior statement: `x; let x;`
 * 2. Use in the initializer of the declaration itself: `let x = x + 1;`
 */
export function checkTDZInStatements(ctx: EarlyErrorContext, stmts: ts.NodeArray<ts.Statement>) {
  // Collect all let/const declarations with their positions
  const letConstDecls = new Map<string, ts.Node>(); // name -> declaration node
  for (const stmt of stmts) {
    if (ts.isVariableStatement(stmt)) {
      const declList = stmt.declarationList;
      const flags = declList.flags;
      const isLetOrConst = (flags & ts.NodeFlags.Let) !== 0 || (flags & ts.NodeFlags.Const) !== 0;
      if (isLetOrConst) {
        for (const decl of declList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            letConstDecls.set(decl.name.text, decl);
          }
        }
      }
    }
  }

  if (letConstDecls.size === 0) return;

  // For each statement, check if it uses a let/const variable that is declared later
  // We need to track which variables have been declared so far
  const declaredSoFar = new Set<string>();

  for (const stmt of stmts) {
    // Before processing this statement's declarations, check for references
    // to not-yet-declared let/const variables
    if (ts.isVariableStatement(stmt)) {
      const declList = stmt.declarationList;
      const flags = declList.flags;
      const isLetOrConst = (flags & ts.NodeFlags.Let) !== 0 || (flags & ts.NodeFlags.Const) !== 0;
      if (isLetOrConst) {
        for (const decl of declList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.initializer) {
            // Check the initializer for self-references (e.g., `let x = x + 1`)
            const varName = decl.name.text;
            if (letConstDecls.has(varName) && !declaredSoFar.has(varName)) {
              checkForTDZRef(ctx, decl.initializer, varName);
            }
          }
          // Now mark this declaration as available
          if (ts.isIdentifier(decl.name)) {
            declaredSoFar.add(decl.name.text);
          }
        }
        continue;
      }
    }

    // For non-declaration statements, check if they reference any
    // let/const variable not yet declared
    for (const [name] of letConstDecls) {
      if (!declaredSoFar.has(name)) {
        checkForTDZRef(ctx, stmt, name);
      }
    }
  }
}

/**
 * Check if a node tree references an identifier by name.
 * Used to detect TDZ violations.
 */
export function checkForTDZRef(ctx: EarlyErrorContext, node: ts.Node, name: string) {
  if (ts.isIdentifier(node) && node.text === name) {
    // Make sure this isn't a property name or type reference
    const parent = node.parent;
    if (parent && ts.isPropertyAccessExpression(parent) && parent.name === node) {
      return; // It's a property name like obj.x, not a variable reference
    }
    if (parent && ts.isPropertyAssignment(parent) && parent.name === node) {
      return; // It's a property name in an object literal
    }
    // Emit as warning — test262 expects runtime ReferenceError, not compile error
    const p = ctx.pos(node);
    ctx.errors.push({
      message: `Cannot access '${name}' before initialization`,
      line: p.line,
      column: p.column,
      severity: "warning",
    });
    return;
  }
  // Don't descend into nested function scopes -- they create their own TDZ
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node)
  ) {
    return;
  }
  forEachChild(node, (child: ts.Node) => checkForTDZRef(ctx, child, name));
}
