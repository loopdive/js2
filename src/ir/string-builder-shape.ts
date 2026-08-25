// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3740) Structural detector for the #1210 string-builder loop shape —
 * `let s = ""` immediately followed by an iteration statement whose body
 * touches `s` only as the LHS of `s += <expr>`.
 *
 * Legacy codegen (`src/codegen/string-builder.ts`) rewrites that shape into
 * a growable (and, per #1761, often presized) WasmGC i16 buffer instead of
 * per-append `__str_concat` cons-node allocation. The IR path
 * (`src/ir/lower.ts` et al.) does not implement that rewrite yet, so an
 * IR-claimed function containing this shape silently regresses to the
 * naive O(N)-allocation concat path — measured ~20x slower (Node's WasmGC
 * engine, `website/public/benchmarks/competitive/programs/string-hash.js`)
 * than the same source compiled legacy (`experimentalIR: false`), because
 * `run`'s untyped `number` params/return satisfy the IR individual-claim
 * gate today. `whyNotIrClaimable` calls `containsStringBuilderLoopShape` to
 * defer such functions to legacy until IR grows its own builder lowering.
 *
 * Deliberately independent of `src/codegen/string-builder.ts`:
 *   - avoids adding a codegen->ir runtime import edge (string-builder.ts
 *     pulls in `compileExpression`/`closures.ts`, which reach back into ir
 *     integration — importing it here risks a real circular module graph).
 *   - does not need `ts.TypeChecker`-based symbol resolution. Being
 *     name-text-based (rather than symbol-identity-based) makes this
 *     detector MORE eager to answer "yes, defer" than the legacy detector's
 *     precise version, which is safe here: a false positive only costs the
 *     IR-specific wins for that one function (legacy still compiles it
 *     correctly, same as any other IR-declined function); a false negative
 *     just leaves an existing regression unfixed for that shape.
 */
import { forEachChild, ts } from "../ts-api.js";
import { containsCountedStringAppendCandidate } from "./analysis/counted-string-append.js";

function isFunctionScopeBoundary(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function isLoopStatement(node: ts.Node): node is ts.IterationStatement {
  return ts.isForStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node);
}

/** `let s = "";` (single declarator, string-literal empty initializer) → `s`'s name, else `null`. */
function emptyStringLetHeadName(stmt: ts.Statement): string | null {
  if (!ts.isVariableStatement(stmt)) return null;
  if (!(stmt.declarationList.flags & ts.NodeFlags.Let)) return null;
  if (stmt.declarationList.declarations.length !== 1) return null;
  const decl = stmt.declarationList.declarations[0]!;
  if (!ts.isIdentifier(decl.name)) return null;
  if (!decl.initializer || !ts.isStringLiteral(decl.initializer) || decl.initializer.text !== "") return null;
  return decl.name.text;
}

/**
 * True iff every reference to identifier `name` inside `loopBody` is the LHS
 * of `name += <expr>`. A nested function scope that mentions `name` at all
 * conservatively counts as a non-append use (matches legacy's closure-capture
 * rejection in spirit, without needing symbol/capture analysis).
 */
function loopBodyOnlyAppends(loopBody: ts.Node, name: string): boolean {
  let ok = true;
  const mentionsName = (node: ts.Node): boolean => {
    if (ts.isIdentifier(node) && node.text === name) return true;
    let found = false;
    forEachChild(node, (child) => {
      if (!found && mentionsName(child)) found = true;
    });
    return found;
  };
  const visit = (node: ts.Node): void => {
    if (!ok) return;
    if (isFunctionScopeBoundary(node)) {
      if (mentionsName(node)) ok = false;
      return;
    }
    if (ts.isIdentifier(node) && node.text === name) {
      const parent = node.parent;
      if (
        !parent ||
        !ts.isBinaryExpression(parent) ||
        parent.left !== node ||
        parent.operatorToken.kind !== ts.SyntaxKind.PlusEqualsToken
      ) {
        ok = false;
      }
      return;
    }
    forEachChild(node, visit);
  };
  visit(loopBody);
  return ok;
}

/**
 * (#3740 / #3744) Legacy-routing gate called by `whyNotIrClaimable`.
 *
 * General builder loops are claimed by IR by default through its
 * `__str_concat_owned` fast path. `JS2WASM_IR_STRING_BUILDER=0` remains the
 * kill switch for that ownership. Constant-count, literal-fragment loops are
 * always deferred because legacy additionally folds all iterations into one
 * `repeat(N)` plus one concat (#1004), which IR does not yet implement.
 */
export function stringBuilderForcedLegacy(body: ts.Node): boolean {
  return (
    (process.env.JS2WASM_IR_STRING_BUILDER === "0" && containsStringBuilderLoopShape(body)) ||
    containsCountedStringAppendCandidate(body)
  );
}

export function containsStringBuilderLoopShape(root: ts.Node): boolean {
  let found = false;
  const scanStatements = (stmts: readonly ts.Statement[]): void => {
    if (found) return;
    for (let i = 0; i + 1 < stmts.length; i++) {
      const name = emptyStringLetHeadName(stmts[i]!);
      if (!name) continue;
      const next = stmts[i + 1]!;
      if (isLoopStatement(next) && loopBodyOnlyAppends(next.statement, name)) {
        found = true;
        return;
      }
    }
  };
  const walk = (node: ts.Node): void => {
    if (found) return;
    if (ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node)) {
      scanStatements(node.statements);
      if (found) return;
    }
    forEachChild(node, (child) => {
      if (found || isFunctionScopeBoundary(child)) return;
      walk(child);
    });
  };
  walk(root);
  return found;
}
