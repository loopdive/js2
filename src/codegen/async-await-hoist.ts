// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#5372) Expression-level await hoisting for the async CFG planner.
//
// An `AwaitExpression` is a suspension point BY SYNTAX. The linear planner
// (`lowerLinearStatements`) only accepts an await that is DIRECTLY the
// initializer / assignment RHS / return operand / expression-statement of a
// top-level statement; every other position (`cond ? await a : b`,
// `cond && await p`, `await (cond ? await a : b)(u, i)`,
// `return cond ? await a : b`) made the whole function fall back to the legacy
// synchronous pass-through, where `await` is an identity and the Promise
// object itself flows on as the value — marked's `parseMarkdown` async arm
// (its 10 Hooks tests) is exactly that shape.
//
// This module lowers such statements into the region items the CFG builder
// (`planTryCatchCfg`) already drives:
//   - a conditional operand with an await in a branch becomes a real
//     `conditional` item — the non-awaiting arm assigns directly and never
//     suspends, the awaiting arm is a suspend segment delivering into the SAME
//     binding (so both arms share one resume local);
//   - `cond && await p` / `cond || await p` as a statement becomes a
//     conditional whose one arm is an unbound suspend segment;
//   - an awaited CALL whose callee itself awaits (`await (c ? await a : b)(u)`)
//     hoists the callee into a synthetic temp (`__async_hoist_<pos>`) that the
//     callee's own lowering delivers/assigns, then suspends on the synthetic
//     `temp(args)` call. The temp is a resume binding of the inner suspend, so
//     the frame emitter allocates its local; it is consumed by the outer
//     await's operand in the same activation and is never live across a
//     suspension, so it needs no frame spill;
//   - `return cond ? await a : b` becomes a conditional whose arms are a
//     `return await` chunk (settleSent) and a synthetic `return b` tail.
//
// Evaluation order is preserved exactly: the only work hoisted ahead of a
// suspension is the condition (evaluated once, by the condGoto) and the
// awaited operand itself; nothing is replayed after resumption.
//
// Pure AST analysis — no `ctx`/`fctx`. Multi-declarator statements delegate
// per declarator so the two previously-accepted shapes (`a = await p` and
// `b = cond ? await q : fallback` with exactly one awaiting arm) produce the
// identical region items they did before.

import { ts } from "../ts-api.js";
import { countAwaitsInStatement } from "./async-cps-ast.js";
import type { LinearAwaitSegment, RegionBody, TryCatchChunk } from "./async-cps.js";

type RegionItem = RegionBody["items"][number];

/** Where a hoisted value lands: a body binding (declarator / assignment target) or a synthetic temp. */
interface HoistTarget {
  readonly name: string;
  readonly type: ts.TypeNode | undefined;
  /** Typing site for the resume coercion (absent for temps → externref). */
  readonly target?: ts.Identifier;
  /** Identifier the immediate (non-suspending) arm assigns through. */
  readonly ident: ts.Identifier;
}

function unwrapParens(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}

function isAwaitFree(node: ts.Node, awaitSet: ReadonlySet<ts.AwaitExpression>): boolean {
  return countAwaitsInStatement(node, awaitSet) === 0;
}

function segment(
  awaitedExpr: ts.Expression,
  resumeBinding: LinearAwaitSegment["resumeBinding"],
  isReturnAwait: boolean,
): LinearAwaitSegment {
  return { leadStmts: [], awaitedExpr, resumeBinding, isReturnAwait, awaitInTry: false, leadInTry: [] };
}

function chunkOf(segs: LinearAwaitSegment[], tail: ts.Statement[], sawReturnAwait: boolean): TryCatchChunk {
  return { segs, tail, sawReturnAwait };
}

function bodyOfChunk(chunk: TryCatchChunk): RegionBody {
  return { items: [{ kind: "chunk", chunk }] };
}

function hoistedBody(items: RegionItem[]): RegionBody {
  return { items, hoisted: true };
}

function bindingOf(target: HoistTarget): NonNullable<LinearAwaitSegment["resumeBinding"]> {
  return target.target !== undefined
    ? { name: target.name, type: target.type, target: target.target }
    : { name: target.name, type: target.type };
}

function assignmentStatement(target: ts.Identifier, value: ts.Expression): ts.ExpressionStatement {
  return ts.factory.createExpressionStatement(
    ts.factory.createBinaryExpression(target, ts.factory.createToken(ts.SyntaxKind.EqualsToken), value),
  );
}

/** Synthetic node bookkeeping so diagnostics (`getStart`/`getSourceFile`) keep working. */
function anchorSynthetic<T extends ts.Node>(node: T, anchor: ts.Node): T {
  ts.setTextRange(node, anchor);
  ts.setOriginalNode(node, anchor);
  (node as { parent?: ts.Node }).parent = anchor.parent;
  return node;
}

function tempTarget(anchor: ts.Node): HoistTarget {
  const name = `__async_hoist_${anchor.pos >= 0 ? anchor.pos : anchor.getStart()}`;
  const ident = anchorSynthetic(ts.factory.createIdentifier(name), anchor);
  return { name, type: undefined, ident };
}

/**
 * `await CALLEE(args)` where CALLEE awaits and every argument is await-free:
 * lower CALLEE into a temp, then suspend on the synthetic `temp(args)`.
 * Returns the callee items plus the final awaited expression, or null.
 */
function hoistAwaitedCallee(
  operand: ts.Expression,
  awaitSet: ReadonlySet<ts.AwaitExpression>,
): { items: RegionItem[]; awaited: ts.Expression } | null {
  const call = unwrapParens(operand);
  if (!ts.isCallExpression(call) || call.questionDotToken !== undefined) return null;
  if (call.arguments.some((a) => ts.isSpreadElement(a) || !isAwaitFree(a, awaitSet))) return null;
  if (isAwaitFree(call.expression, awaitSet)) return null;
  const temp = tempTarget(call.expression);
  const calleeBody = lowerValueInto(temp, call.expression, awaitSet);
  if (calleeBody === null) return null;
  const synthetic = anchorSynthetic(ts.factory.createCallExpression(temp.ident, undefined, [...call.arguments]), call);
  return { items: [...calleeBody.items], awaited: synthetic };
}

/** Lower `expr` so that its value lands in `target`. */
function lowerValueInto(
  target: HoistTarget,
  expr: ts.Expression,
  awaitSet: ReadonlySet<ts.AwaitExpression>,
): RegionBody | null {
  const e = unwrapParens(expr);
  if (ts.isAwaitExpression(e) && awaitSet.has(e)) {
    if (isAwaitFree(e.expression, awaitSet)) {
      return bodyOfChunk(chunkOf([segment(e.expression, bindingOf(target), false)], [], false));
    }
    const hoisted = hoistAwaitedCallee(e.expression, awaitSet);
    if (hoisted === null) return null;
    return hoistedBody([
      ...hoisted.items,
      { kind: "chunk", chunk: chunkOf([segment(hoisted.awaited, bindingOf(target), false)], [], false) },
    ]);
  }
  if (ts.isConditionalExpression(e) && isAwaitFree(e.condition, awaitSet)) {
    const branch = (arm: ts.Expression): RegionBody | null =>
      isAwaitFree(arm, awaitSet)
        ? bodyOfChunk(chunkOf([], [assignmentStatement(target.ident, arm)], false))
        : lowerValueInto(target, arm, awaitSet);
    const whenTrue = branch(e.whenTrue);
    const whenFalse = branch(e.whenFalse);
    if (whenTrue === null || whenFalse === null) return null;
    return {
      items: [{ kind: "conditional", condition: e.condition, whenTrue, whenFalse }],
      ...(whenTrue.hoisted === true || whenFalse.hoisted === true ? { hoisted: true } : {}),
    };
  }
  return null;
}

/** Lower an awaiting expression whose value is discarded (statement position). */
function lowerEffect(expr: ts.Expression, awaitSet: ReadonlySet<ts.AwaitExpression>): RegionBody | null {
  const e = unwrapParens(expr);
  if (!ts.isAwaitExpression(e) || !awaitSet.has(e)) return null;
  if (isAwaitFree(e.expression, awaitSet)) {
    return bodyOfChunk(chunkOf([segment(e.expression, null, false)], [], false));
  }
  const hoisted = hoistAwaitedCallee(e.expression, awaitSet);
  if (hoisted === null) return null;
  return hoistedBody([
    ...hoisted.items,
    { kind: "chunk", chunk: chunkOf([segment(hoisted.awaited, null, false)], [], false) },
  ]);
}

/** Lower `return <expr>` whose operand awaits somewhere other than directly. */
function lowerReturnValue(expr: ts.Expression, awaitSet: ReadonlySet<ts.AwaitExpression>): RegionBody | null {
  const e = unwrapParens(expr);
  if (ts.isAwaitExpression(e) && awaitSet.has(e)) {
    if (isAwaitFree(e.expression, awaitSet)) {
      return bodyOfChunk(chunkOf([segment(e.expression, null, true)], [], true));
    }
    const hoisted = hoistAwaitedCallee(e.expression, awaitSet);
    if (hoisted === null) return null;
    return hoistedBody([
      ...hoisted.items,
      { kind: "chunk", chunk: chunkOf([segment(hoisted.awaited, null, true)], [], true) },
    ]);
  }
  if (ts.isConditionalExpression(e) && isAwaitFree(e.condition, awaitSet)) {
    const branch = (arm: ts.Expression): RegionBody | null =>
      isAwaitFree(arm, awaitSet)
        ? bodyOfChunk(chunkOf([], [anchorSynthetic(ts.factory.createReturnStatement(arm), arm)], false))
        : lowerReturnValue(arm, awaitSet);
    const whenTrue = branch(e.whenTrue);
    const whenFalse = branch(e.whenFalse);
    if (whenTrue === null || whenFalse === null) return null;
    return hoistedBody([{ kind: "conditional", condition: e.condition, whenTrue, whenFalse }]);
  }
  return null;
}

/**
 * Lower a (possibly multi-declarator) variable statement whose initializers
 * suspend, in source order. Locals are allocated from the original
 * declarations before body emission, so the CFG only delivers/assigns their
 * values. Returns null for the linear-canonical single `x = await p` (the
 * chunk path owns it, byte-identically) and for anything off-shape.
 */
function lowerVariableStatement(
  stmt: ts.VariableStatement,
  awaitSet: ReadonlySet<ts.AwaitExpression>,
): RegionBody | null {
  const decls = stmt.declarationList.declarations;
  if (decls.length === 1) {
    const init = decls[0]!.initializer;
    if (
      init !== undefined &&
      ts.isAwaitExpression(init) &&
      awaitSet.has(init) &&
      isAwaitFree(init.expression, awaitSet)
    ) {
      return null;
    }
  }
  const items: RegionItem[] = [];
  let hoisted = false;
  for (const decl of decls) {
    if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) return null;
    if (isAwaitFree(decl.initializer, awaitSet)) {
      items.push({ kind: "chunk", chunk: chunkOf([], [assignmentStatement(decl.name, decl.initializer)], false) });
      hoisted = true;
      continue;
    }
    const body = lowerValueInto(
      { name: decl.name.text, type: decl.type, target: decl.name, ident: decl.name },
      decl.initializer,
      awaitSet,
    );
    if (body === null) return null;
    items.push(...body.items);
    if (body.hoisted === true) hoisted = true;
  }
  return hoisted ? hoistedBody(items) : { items };
}

/**
 * The pre-#5372 planner arm, verbatim — what the wasi / standalone lanes keep
 * using (`hoist === false`), so their acceptance AND emitted items are
 * byte-identical. The host lane's `lowerVariableStatement` below produces the
 * identical items for the two shapes accepted here and widens beyond them.
 *
 * Lower a multi-declarator statement whose initializers suspend in source
 * order. This is the minified-package form of sequential declarations such as
 * `let a = await p, b = cond ? await q : fallback`.
 *
 * Locals are allocated from the original declarations before body emission,
 * so the CFG only needs to deliver/assign their initializer values. A
 * conditional await becomes a real branch: the non-await arm assigns directly
 * and does not manufacture an extra microtask turn.
 */
function lowerAwaitingVariableStatementNarrow(
  stmt: ts.VariableStatement,
  awaitSet: ReadonlySet<ts.AwaitExpression>,
): RegionBody | null {
  const decls = stmt.declarationList.declarations;
  if (decls.length < 2) return null;
  const items: RegionBody["items"] extends readonly (infer T)[] ? T[] : never = [];
  let seen = 0;
  for (const decl of decls) {
    if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) return null;
    const initializer = decl.initializer;
    if (ts.isAwaitExpression(initializer) && awaitSet.has(initializer)) {
      items.push({
        kind: "chunk",
        chunk: {
          segs: [
            {
              leadStmts: [],
              awaitedExpr: initializer.expression,
              resumeBinding: { name: decl.name.text, type: decl.type, target: decl.name },
              isReturnAwait: false,
              awaitInTry: false,
              leadInTry: [],
            },
          ],
          tail: [],
          sawReturnAwait: false,
        },
      });
      seen++;
      continue;
    }
    if (ts.isConditionalExpression(initializer)) {
      const trueAwait = ts.isAwaitExpression(initializer.whenTrue) && awaitSet.has(initializer.whenTrue);
      const falseAwait = ts.isAwaitExpression(initializer.whenFalse) && awaitSet.has(initializer.whenFalse);
      if (trueAwait === falseAwait) return null; // exactly one branch suspends
      const awaited = (trueAwait ? initializer.whenTrue : initializer.whenFalse) as ts.AwaitExpression;
      const immediate = (trueAwait ? initializer.whenFalse : initializer.whenTrue) as ts.Expression;
      const suspendChunk: TryCatchChunk = {
        segs: [
          {
            leadStmts: [],
            awaitedExpr: awaited.expression,
            resumeBinding: { name: decl.name.text, type: decl.type, target: decl.name },
            isReturnAwait: false,
            awaitInTry: false,
            leadInTry: [],
          },
        ],
        tail: [],
        sawReturnAwait: false,
      };
      const immediateChunk: TryCatchChunk = {
        segs: [],
        tail: [assignmentStatement(decl.name, immediate)],
        sawReturnAwait: false,
      };
      items.push({
        kind: "conditional",
        condition: initializer.condition,
        whenTrue: bodyOfChunk(trueAwait ? suspendChunk : immediateChunk),
        whenFalse: bodyOfChunk(trueAwait ? immediateChunk : suspendChunk),
      });
      seen++;
      continue;
    }
    return null;
  }
  return seen === decls.length ? { items } : null;
}

/**
 * Lower one top-level statement whose await(s) sit inside an expression into
 * region items. Returns null when the statement is linear-canonical (the chunk
 * path owns it) or outside the bounded shapes above. `hoist === false` (wasi /
 * standalone lanes) keeps the pre-#5372 multi-declarator-only arm.
 */
export function lowerAwaitingStatementByHoisting(
  stmt: ts.Statement,
  awaitSet: ReadonlySet<ts.AwaitExpression>,
  hoist: boolean,
): RegionBody | null {
  if (!hoist) return ts.isVariableStatement(stmt) ? lowerAwaitingVariableStatementNarrow(stmt, awaitSet) : null;
  if (ts.isVariableStatement(stmt)) return lowerVariableStatement(stmt, awaitSet);
  if (ts.isExpressionStatement(stmt)) {
    const e = unwrapParens(stmt.expression);
    if (!ts.isBinaryExpression(e)) return null;
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.EqualsToken) {
      if (!ts.isIdentifier(e.left)) return null;
      const rhs = unwrapParens(e.right);
      if (ts.isAwaitExpression(rhs) && awaitSet.has(rhs) && isAwaitFree(rhs.expression, awaitSet)) return null;
      const body = lowerValueInto(
        { name: e.left.text, type: undefined, target: e.left, ident: e.left },
        e.right,
        awaitSet,
      );
      return body === null ? null : hoistedBody([...body.items]);
    }
    if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
      if (!isAwaitFree(e.left, awaitSet)) return null;
      const effect = lowerEffect(e.right, awaitSet);
      if (effect === null) return null;
      const empty: RegionBody = { items: [] };
      const isAnd = op === ts.SyntaxKind.AmpersandAmpersandToken;
      return hoistedBody([
        { kind: "conditional", condition: e.left, whenTrue: isAnd ? effect : empty, whenFalse: isAnd ? empty : effect },
      ]);
    }
    return null;
  }
  if (ts.isReturnStatement(stmt) && stmt.expression !== undefined) {
    const e = unwrapParens(stmt.expression);
    if (ts.isAwaitExpression(e) && awaitSet.has(e) && isAwaitFree(e.expression, awaitSet)) return null;
    return lowerReturnValue(stmt.expression, awaitSet);
  }
  return null;
}
