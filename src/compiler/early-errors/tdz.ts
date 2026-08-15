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

  // For each statement, check if it uses a let/const variable that is declared later.
  // #4432: the pending set (declared-later names) is traversed ONCE per statement
  // instead of once per pending name — the old shape was O(pending × subtree).
  // `pendingOrder` preserves letConstDecls' Map insertion order and `pending`
  // tracks which of those are still un-declared; together they reproduce the
  // original emission order exactly (grouped by name in map order, then by node
  // encounter order within each name).
  const pendingOrder = [...letConstDecls.keys()];
  const pending = new Set<string>(pendingOrder);
  const matches = new Map<string, ts.Node[]>();

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
            if (letConstDecls.has(varName) && pending.has(varName)) {
              checkForTDZRef(ctx, decl.initializer, varName);
            }
          }
          // Now mark this declaration as available
          if (ts.isIdentifier(decl.name)) {
            pending.delete(decl.name.text);
          }
        }
        continue;
      }
    }

    // For non-declaration statements, check if they reference any
    // let/const variable not yet declared
    if (pending.size === 0) continue;
    matches.clear();
    collectTDZRefs(stmt, pending, matches);
    if (matches.size === 0) continue;
    for (const name of pendingOrder) {
      if (!pending.has(name)) continue;
      const nodes = matches.get(name);
      if (nodes === undefined) continue;
      for (const refNode of nodes) {
        // Emit as warning — test262 expects runtime ReferenceError, not compile error
        const p = ctx.pos(refNode);
        ctx.errors.push({
          message: `Cannot access '${name}' before initialization`,
          line: p.line,
          column: p.column,
          severity: "warning",
        });
      }
    }
  }
}

/**
 * Single-traversal generalization of `checkForTDZRef` (#4432): records every
 * identifier reference to ANY name in `names`, bucketed by name in node
 * encounter order. The match test, the two property-name exclusions and the
 * five nested-scope descent boundaries are ported verbatim from
 * `checkForTDZRef`; only emission is deferred to the caller so that the
 * original grouped-by-name ordering is preserved.
 *
 * #4453: a nested block scope that re-declares a pending name shadows the outer
 * binding throughout its subtree, so a reference there is to the INNER binding
 * and is not a TDZ violation of the outer declaration:
 *
 *     if (c) { const x = 1; use(x); }   // ← both were flagged before #4453
 *     const x = 2;
 *
 * The shadowed names are subtracted from `names` for that subtree only, which
 * narrows what the single traversal matches without adding a traversal — the
 * #4432 structure and its emission order are unchanged (removing matches cannot
 * reorder the ones that remain).
 */
function collectTDZRefs(node: ts.Node, names: Set<string>, matches: Map<string, ts.Node[]>): void {
  if (ts.isIdentifier(node)) {
    const text = node.text;
    if (names.has(text)) {
      // Make sure this isn't a property name or type reference
      const parent = node.parent;
      if (parent && ts.isPropertyAccessExpression(parent) && parent.name === node) {
        return; // It's a property name like obj.x, not a variable reference
      }
      if (parent && ts.isPropertyAssignment(parent) && parent.name === node) {
        return; // It's a property name in an object literal
      }
      const bucket = matches.get(text);
      if (bucket === undefined) matches.set(text, [node]);
      else bucket.push(node);
      return;
    }
    // Non-matching identifiers have no children to descend into; falling
    // through matches the original (forEachChild on an Identifier is a no-op).
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
  const inner = shadowedNames(node, names);
  if (inner !== undefined) {
    // Every pending name is shadowed here — nothing in this subtree can name an
    // outer binding, so the whole subtree is skipped.
    if (inner.size === 0) return;
    forEachChild(node, (child: ts.Node) => collectTDZRefs(child, inner, matches));
    return;
  }
  forEachChild(node, (child: ts.Node) => collectTDZRefs(child, names, matches));
}

/**
 * The scopes a TDZ reference scan can descend into that introduce lexical
 * bindings of their own (#4453). Function and class scopes are NOT here: the
 * scan stops at those outright, before this is consulted.
 */
function isNestedLexicalScope(node: ts.Node): boolean {
  return (
    ts.isBlock(node) ||
    ts.isCaseBlock(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isCatchClause(node)
  );
}

/**
 * `names` minus the lexical names `node` introduces, or `undefined` when `node`
 * is not a nested lexical scope OR declares none of `names` (#4453).
 *
 * `undefined` deliberately covers both cases: both mean *keep traversing with
 * the caller's set*, and collapsing them keeps the check allocation-free on the
 * hot path — a narrowed Set is built only for a scope that actually re-declares
 * a pending name, which is rare.
 *
 * What each boundary contributes:
 * - `Block` — its LexicallyDeclaredNames: let/const (including destructuring
 *   patterns), plus function and class declarations.
 * - `CaseBlock` — one shared scope across every clause (ES §14.12.2).
 * - `for` / `for-in` / `for-of` — a let/const head binding scopes over the
 *   whole statement, head and body alike.
 * - `CatchClause` — the catch parameter binding.
 */
function shadowedNames(node: ts.Node, names: Set<string>): Set<string> | undefined {
  if (ts.isBlock(node)) {
    return shadowStatementList(node.statements, names, undefined);
  }
  if (ts.isCaseBlock(node)) {
    let out: Set<string> | undefined;
    for (const clause of node.clauses) {
      out = shadowStatementList(clause.statements, names, out);
    }
    return out;
  }
  if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) {
    const init = node.initializer;
    if (init === undefined || !ts.isVariableDeclarationList(init)) return undefined;
    const flags = init.flags;
    if ((flags & ts.NodeFlags.Let) === 0 && (flags & ts.NodeFlags.Const) === 0) return undefined;
    let out: Set<string> | undefined;
    for (const decl of init.declarations) {
      out = shadowBinding(decl.name, names, out);
    }
    return out;
  }
  if (ts.isCatchClause(node)) {
    if (node.variableDeclaration === undefined) return undefined;
    return shadowBinding(node.variableDeclaration.name, names, undefined);
  }
  return undefined;
}

/** Subtract a statement list's lexically-declared names from `names` (#4453). */
function shadowStatementList(
  stmts: readonly ts.Statement[],
  names: Set<string>,
  out: Set<string> | undefined,
): Set<string> | undefined {
  for (const stmt of stmts) {
    if (ts.isVariableStatement(stmt)) {
      const flags = stmt.declarationList.flags;
      if ((flags & ts.NodeFlags.Let) !== 0 || (flags & ts.NodeFlags.Const) !== 0) {
        for (const decl of stmt.declarationList.declarations) {
          out = shadowBinding(decl.name, names, out);
        }
      }
    } else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      out = shadowName(stmt.name.text, names, out);
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      out = shadowName(stmt.name.text, names, out);
    }
  }
  return out;
}

/** Subtract every identifier bound by a (possibly destructuring) binding name. */
function shadowBinding(
  name: ts.BindingName,
  names: Set<string>,
  out: Set<string> | undefined,
): Set<string> | undefined {
  if (ts.isIdentifier(name)) return shadowName(name.text, names, out);
  for (const el of name.elements) {
    if (ts.isBindingElement(el)) out = shadowBinding(el.name, names, out);
  }
  return out;
}

/**
 * Subtract one name, materializing the narrowed set only on a real hit. `out`
 * is always a subset of `names`, so once it exists the delete is unconditional.
 */
function shadowName(text: string, names: Set<string>, out: Set<string> | undefined): Set<string> | undefined {
  if (out !== undefined) {
    out.delete(text);
    return out;
  }
  if (!names.has(text)) return undefined;
  const narrowed = new Set(names);
  narrowed.delete(text);
  return narrowed;
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
  // #4453: same shadowing rule as `collectTDZRefs`. This path scans a single
  // declaration's initializer, where a nested lexical scope is reachable only
  // through a node that is not one of the function-like boundaries above (an
  // object-literal method body, say) — rare enough that the probe Set is built
  // only once the kind test has already matched.
  if (isNestedLexicalScope(node) && shadowedNames(node, new Set([name])) !== undefined) return;
  forEachChild(node, (child: ts.Node) => checkForTDZRef(ctx, child, name));
}
