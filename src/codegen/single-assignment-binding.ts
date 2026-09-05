// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4491 wave-5 T2) "Is this identifier a binding that is written exactly
 * once?" — answered per BINDING, not per NAME.
 *
 * ## Why the name-level answer is not usable in test262
 *
 * `object-ctor-primitive-receiver.ts` (#4232) traces a receiver identifier back
 * to its initializer so a `.constructor` read can tell `Object(5)` (a Number
 * wrapper) from `Object({})` (an ordinary object). It only dares do that for a
 * single-assignment binding, and it proved single-assignment with a NAME-level
 * scan of the source file: any assignment to, or second declaration of, that
 * spelling anywhere poisons it. Its own note calls the over-rejection "the safe
 * direction".
 *
 * It is the safe direction, and in test262 it is also the ALWAYS direction. A
 * test262 file is compiled as ONE source: the test body concatenated with
 * `assert.js`, `sta.js`, `propertyHelper.js`, `compareArray.js`. Those harness
 * files take parameters and declare locals named `a`, `b`, `obj`, `x`, `desc`,
 * `key`, `value` — the same short names test bodies use. Measured on this
 * branch: `var a = new Object(1.1); a.constructor` traced to "a POISONED", and
 * so did every other spelling worth tracing. The guard could not fire, and
 * `built-ins/Object/prototype/valueOf/S15.2.4.4_A1_T{1,2,3}` (whose binding is
 * `obj`) failed for that reason alone.
 *
 * ## What this answers instead
 *
 * Two questions, both about the identifier's own binding:
 *
 * 1. `declarationsOf(id)` — exactly one declaration, so the binding is not
 *    redeclared or merged;
 * 2. no assignment / update / for-in-of loop variable anywhere in the file
 *    RESOLVES to that same declaration.
 *
 * A harness parameter named `obj` is a different declaration, so it no longer
 * poisons the test body's `var obj`. A genuine `obj = …` on the SAME binding
 * still does.
 *
 * ## Cost, and why it is bounded
 *
 * The file is walked once per source file and cached, collecting only the
 * identifiers that could WRITE a binding, keyed by spelling. The checker is
 * then consulted only for occurrences that share the queried spelling —
 * usually none. This is the "sharper but has to resolve every occurrence
 * through the checker" option #4232 named and deferred; the resolution is
 * per-spelling, not per-occurrence, which is what keeps it affordable.
 *
 * Every uncertainty answers `false` (treat the binding as rebound), preserving
 * the caller's conservative direction.
 */
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";

/** Per-file, per-spelling: identifiers that WRITE some binding of that name. */
const writeCache = new WeakMap<ts.SourceFile, Map<string, ts.Identifier[]>>();

function writingOccurrences(sourceFile: ts.SourceFile): Map<string, ts.Identifier[]> {
  let byName = writeCache.get(sourceFile);
  if (byName !== undefined) return byName;
  byName = new Map<string, ts.Identifier[]>();
  const record = (id: ts.Identifier): void => {
    const list = byName!.get(id.text);
    if (list) list.push(id);
    else byName!.set(id.text, [id]);
  };
  const recordAssignmentTarget = (target: ts.Node): void => {
    if (ts.isIdentifier(target)) {
      record(target);
      return;
    }
    if (ts.isParenthesizedExpression(target)) {
      recordAssignmentTarget(target.expression);
      return;
    }
    if (ts.isBindingElement(target)) {
      recordAssignmentTarget(target.name);
      return;
    }
    if (ts.isObjectBindingPattern(target)) {
      for (const element of target.elements) recordAssignmentTarget(element);
      return;
    }
    if (ts.isArrayBindingPattern(target)) {
      for (const element of target.elements) {
        if (ts.isOmittedExpression(element)) continue;
        recordAssignmentTarget(element);
      }
      return;
    }
    if (ts.isObjectLiteralExpression(target)) {
      for (const property of target.properties) {
        if (ts.isPropertyAssignment(property)) {
          recordAssignmentTarget(property.initializer);
        } else if (ts.isShorthandPropertyAssignment(property)) {
          record(property.name);
        } else if (ts.isSpreadAssignment(property)) {
          recordAssignmentTarget(property.expression);
        }
      }
      return;
    }
    if (ts.isArrayLiteralExpression(target)) {
      for (const element of target.elements) {
        if (ts.isSpreadElement(element)) recordAssignmentTarget(element.expression);
        else recordAssignmentTarget(element);
      }
    }
  };
  const walk = (node: ts.Node): void => {
    // `x = …`, `x += …`, and every other compound assignment.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      recordAssignmentTarget(node.left);
    }
    // `x++` / `--x`.
    if (
      (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) &&
      ts.isIdentifier(node.operand) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      record(node.operand);
    }
    // A for-in/for-of loop variable is re-assigned on every iteration.
    if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      if (ts.isVariableDeclarationList(node.initializer)) {
        for (const declaration of node.initializer.declarations) recordAssignmentTarget(declaration.name);
      } else {
        recordAssignmentTarget(node.initializer);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(sourceFile);
  writeCache.set(sourceFile, byName);
  return byName;
}

/**
 * Is `id`'s binding declared exactly once and never assigned after its
 * initializer? `false` on any doubt — an unresolvable binding, more than one
 * declaration, or an occurrence the checker cannot place.
 */
export function bindingIsSingleAssignment(ctx: CodegenContext, id: ts.Identifier): boolean {
  const decls = ctx.oracle.declarationsOf(id);
  if (decls.length !== 1) return false;
  const decl = decls[0];
  if (decl === undefined) return false;
  const writes = writingOccurrences(id.getSourceFile()).get(id.text);
  if (writes === undefined) return true;
  for (const write of writes) {
    const target = ctx.oracle.valueDeclarationOf(write);
    // An occurrence the checker cannot place could be this binding.
    if (target === undefined) return false;
    if (target === decl) return false;
  }
  return true;
}

/**
 * Whether a binding has a write before `before` in the same source file.
 *
 * This is deliberately a conservative, source-order proof rather than a
 * control-flow analysis. A write in a nested function is considered visible
 * when it appears before the evaluation point; the function may run before
 * that point, and declining the initializer shortcut is safer than freezing a
 * value that the runtime can change. Writes after the point are irrelevant to
 * a class heritage expression evaluated at that point.
 */
export function bindingHasWriteBefore(ctx: CodegenContext, id: ts.Identifier, before: ts.Node): boolean {
  const decls = ctx.oracle.declarationsOf(id);
  if (decls.length !== 1) return true;
  const decl = decls[0];
  if (decl === undefined) return true;
  const sourceFile = id.getSourceFile();
  if (before.getSourceFile() !== sourceFile) return true;
  let beforePos: number;
  try {
    beforePos = before.getStart(sourceFile);
  } catch {
    beforePos = before.pos;
  }
  if (beforePos < 0) return true;
  const writes = writingOccurrences(sourceFile).get(id.text);
  if (writes === undefined) return false;
  for (const write of writes) {
    let writePos: number;
    try {
      writePos = write.getStart(sourceFile);
    } catch {
      writePos = write.pos;
    }
    // A write in a nested/hoisted function may execute before the class even
    // when its function body is lexically after it (`f(); class C extends P
    // {}; function f() { P = Object; }`). Keep direct top-level writes after
    // the class irrelevant, but conservatively retain nested function writes.
    const nestedFunctionWrite = write.parent !== undefined && isInsideFunction(write);
    if ((writePos < 0 || writePos >= beforePos) && !nestedFunctionWrite) continue;
    const target = ctx.oracle.valueDeclarationOf(write);
    // An occurrence the checker cannot place could be this binding. Treat it
    // as an earlier write so the caller keeps the runtime path.
    if (target === undefined || target === decl) return true;
  }
  return false;
}

function isInsideFunction(node: ts.Node): boolean {
  for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
    if (ts.isFunctionLike(parent)) return true;
    if (ts.isSourceFile(parent)) return false;
  }
  return false;
}
