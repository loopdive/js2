// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6731) `break` / `continue`, labelled statements and `switch` inside the
 * Wasm-native generator state machine (`generators-native.ts`). Standalone/WASI
 * only — the JS-host lane keeps its eager buffer for these shapes.
 *
 * WHY. A structurally lowered loop is not a wasm loop: its header, body and
 * exit are separate STATES of the resume trampoline, so a `break` compiled by
 * `compileStatement` (a wasm `br`) has no enclosing wasm block to target. Until
 * this module every yielding loop whose body held a `break`/`continue` refused
 * the generator (`loopBodyHasUnsupportedJump`), and so did every `switch` with a
 * yield in a case. Minified bundles are full of both (tailwindcss's candidate
 * parser `ti`, its `-` splitter `ii`, the `@utility` walker `Gi`).
 *
 * HOW. The planner keeps a stack of `JumpTarget`s — one per structurally
 * lowered loop / switch / labelled block — each naming the state a `break`
 * lands on (and, for a loop, the state a `continue` lands on: the header, or a
 * `for`'s update). A statement holding a jump that ESCAPES it
 * (`statementHasEscapingJump`) is lowered structurally, so the jump itself
 * becomes a `jump` terminator to that state. What the jump leaves on its way
 * out (§14.7.5.7 IteratorClose of a for-of it exits, a yield-free `finally` it
 * crosses) is replayed by the planner before the terminator.
 *
 * `switch` (§14.12.4 CaseBlockEvaluation) is lowered here over a small host:
 * the discriminant is evaluated ONCE into a frame spill, each case selector is
 * evaluated in source order (the clauses before `default`, then the ones after
 * it) only while no earlier selector matched, and compared with
 * IsStrictlyEqual (`__extern_strict_eq`). Case bodies are consecutive states, so
 * fall-through is a plain jump to the next body; `break` targets the exit.
 */
import { ts } from "../ts-api.js";
import type { TypeFact } from "../checker/oracle.js";
import { isFunctionLikeScope } from "./generators-native-ast-scan.js";
import {
  type LinearCloseEntry,
  type LinearizeHost,
  planLinearClose,
  planLinearEval,
  planLinearStrictEq,
} from "./generator-yield-linearize.js";

/** One structurally lowered construct a `break` / `continue` can target. */
export interface JumpTarget {
  /** Labels naming this construct (`a: b: for (…)`). */
  labels: readonly string[];
  /** A loop: `continue` binds here. */
  isLoop: boolean;
  /** A loop or `switch`: an UNLABELLED `break` binds here (a labelled block does not). */
  unlabelledBreak: boolean;
  breakState: number;
  continueState?: number;
  /** Length of the planner's unwind chain at the construct — entries past it are crossed by the jump. */
  breakDepth: number;
  continueDepth?: number;
}

/**
 * True when `stmt` holds a `break` / `continue` (of THIS function) whose target
 * lies OUTSIDE `stmt`. Such a statement cannot be compiled as a straight-line
 * prelude statement inside a state: its wasm `br` would have no target.
 */
export function statementHasEscapingJump(stmt: ts.Statement): boolean {
  let found = false;
  const visit = (node: ts.Node, loops: number, breakables: number, labels: readonly string[]): void => {
    if (found || isFunctionLikeScope(node) || ts.isClassLike(node)) return;
    if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) {
      const label = node.label?.text;
      if (label !== undefined) found = !labels.includes(label);
      else found = ts.isBreakStatement(node) ? breakables === 0 : loops === 0;
      return;
    }
    if (ts.isLabeledStatement(node)) {
      visit(node.statement, loops, breakables, [...labels, node.label.text]);
      return;
    }
    const isLoop = ts.isIterationStatement(node, false);
    const breakable = isLoop || ts.isSwitchStatement(node);
    ts.forEachChild(node, (child) => visit(child, loops + (isLoop ? 1 : 0), breakables + (breakable ? 1 : 0), labels));
  };
  visit(stmt, 0, 0, []);
  return found;
}

/** A `return` of THIS function inside `node`. */
function containsReturn(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found || isFunctionLikeScope(n)) return;
    if (ts.isReturnStatement(n)) found = true;
    else ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/**
 * A for-of the A2 `for-of-step` loop cannot carry, so the linearised loop
 * (whose record is an ordinary `dstr-close` entry) drives it even over a typed
 * iterator: a binding-pattern head, or a body that leaves it by `return` /
 * `break` / `continue` (A2's record is closed only by an abrupt resume).
 */
export function forOfNeedsLinearDrive(stmt: ts.ForOfStatement): boolean {
  const init = stmt.initializer;
  if (ts.isVariableDeclarationList(init) && init.declarations.some((d) => !ts.isIdentifier(d.name))) return true;
  return statementHasEscapingJump(stmt.statement) || containsReturn(stmt.statement);
}

/** (#6731) An `any[]` binding — the spill resolver defers it (see its `Array<any>` arm). */
export function isAnyArrayFact(fact: TypeFact): boolean {
  return fact.kind === "array" && fact.element.kind === "any";
}

/** Every identifier a binding pattern binds, nested patterns included. */
export function bindingPatternIdentifiers(pattern: ts.BindingPattern): ts.Identifier[] {
  const ids: ts.Identifier[] = [];
  for (const el of pattern.elements) {
    if (ts.isOmittedExpression(el)) continue;
    if (ts.isIdentifier(el.name)) ids.push(el.name);
    else ids.push(...bindingPatternIdentifiers(el.name));
  }
  return ids;
}

/** The innermost target `jump` binds to (undefined = not a structurally lowered construct). */
export function findJumpTarget(
  targets: readonly JumpTarget[],
  jump: ts.BreakStatement | ts.ContinueStatement,
): JumpTarget | undefined {
  const label = jump.label?.text;
  const isBreak = ts.isBreakStatement(jump);
  for (let i = targets.length - 1; i >= 0; i--) {
    const t = targets[i]!;
    if (label !== undefined) {
      if (!t.labels.includes(label)) continue;
      return isBreak || t.isLoop ? t : undefined;
    }
    if (isBreak ? t.unlabelledBreak : t.isLoop) return t;
  }
  return undefined;
}

/** The planner operations `lowerSwitchStatement` needs. */
export interface SwitchHost<U> {
  /** Evaluate `expr` once into a fresh frame spill (a direct `yield` suspends); undefined = refuse. */
  evalToSpill(expr: ts.Expression, unwind: readonly U[]): string | undefined;
  /** An i32 spill holding IsStrictlyEqual(spill `a`, spill `b`). */
  strictEq(a: string, b: string): string;
  reserve(): number;
  enter(id: number): void;
  jump(next: number): void;
  /** Finish the current state: i32 spill `flag` ? thenState : elseState. */
  branch(flag: string, thenState: number, elseState: number): void;
  /** Lower a case body with `target` on the jump-target stack. */
  lowerBody(statements: readonly ts.Statement[], unwind: readonly U[], target: JumpTarget): boolean;
}

/** How a jump leaving an unwind-chain entry treats it. */
export type CrossedEntry =
  /** A yield-free `finally` — its statements run on the way out. */
  | { kind: "replay"; statements: readonly ts.Statement[] }
  /** Leaving it needs no code (a `catch` handler). */
  | { kind: "pass" }
  /** A linearised iterator record — closed with a normal completion. */
  | { kind: "close"; entry: LinearCloseEntry }
  /** Not modelled (a state-lowered `finally`, an A2 `for-of-step` record). */
  | { kind: "refuse" };

/** The planner surface the jump / switch / label lowering composes. */
export interface StructuredJumpHost<U> {
  linear: LinearizeHost<U>;
  targets: readonly JumpTarget[];
  classify(entry: U): CrossedEntry;
  /** Finish the current state with a jump to `next`; continue in a fresh (dead) state. */
  finish(next: number): void;
  /** Append yield-free statements to the current state. */
  replay(statements: readonly ts.Statement[]): void;
  /** Lower `statements` with `target` pushed on the jump-target stack. */
  lowerBody(statements: readonly ts.Statement[], unwind: readonly U[], target: JumpTarget): boolean;
  /** Labels a LabeledStatement handed to the construct being lowered. */
  takeLabels(): string[];
}

/**
 * `break` / `continue` [label] — §14.7.1.2 LoopContinues / §14.13 LabelledEvaluation.
 * Every unwind entry between the jump and its target is left innermost-first:
 * a yield-free `finally` is replayed, a for-of's record is closed (§14.7.5.7
 * step 6 — `continue` of that same loop keeps it open). Undefined target or an
 * unmodelled entry = refuse.
 */
export function lowerJumpStatement<U>(
  host: StructuredJumpHost<U>,
  jump: ts.BreakStatement | ts.ContinueStatement,
  unwind: readonly U[],
): boolean {
  const target = findJumpTarget(host.targets, jump);
  if (!target) return false;
  const isBreak = ts.isBreakStatement(jump);
  const next = isBreak ? target.breakState : target.continueState;
  const depth = isBreak ? target.breakDepth : target.continueDepth;
  if (next === undefined || depth === undefined) return false;
  const crossed = unwind.map((entry) => host.classify(entry));
  if (crossed.slice(depth).some((c) => c.kind === "refuse")) return false;
  for (let i = unwind.length - 1; i >= depth; i--) {
    const c = crossed[i]!;
    if (c.kind === "replay") host.replay(c.statements);
    else if (c.kind === "close") {
      const outer = crossed.slice(0, i).flatMap((o) => (o.kind === "close" ? [o.entry] : []));
      planLinearClose(host.linear, c.entry, outer);
    }
  }
  host.finish(next);
  return true;
}

/**
 * `l1: l2: <statement>`. A labelled loop / `switch` is lowered by
 * `lowerLabelled(inner, labels)` (the planner hands the labels to it); any
 * other statement becomes a block whose `break l1` lands after it.
 */
export function lowerLabeledStatement<U>(
  host: StructuredJumpHost<U>,
  stmt: ts.LabeledStatement,
  unwind: readonly U[],
  lowerLabelled: (inner: ts.Statement, labels: string[]) => boolean,
): boolean {
  const labels: string[] = [];
  let inner: ts.Statement = stmt;
  while (ts.isLabeledStatement(inner)) {
    labels.push(inner.label.text);
    inner = inner.statement;
  }
  if (ts.isIterationStatement(inner, false) || ts.isSwitchStatement(inner)) return lowerLabelled(inner, labels);
  const exit = host.linear.reserve();
  const target: JumpTarget = {
    labels,
    isLoop: false,
    unlabelledBreak: false,
    breakState: exit,
    breakDepth: unwind.length,
  };
  if (!host.lowerBody(ts.isBlock(inner) ? inner.statements : [inner], unwind, target)) return false;
  host.linear.jump(exit);
  host.linear.enter(exit);
  return true;
}

/** `switch` over the planner (see `lowerSwitchStatement`). */
export function lowerPlannedSwitch<U>(
  host: StructuredJumpHost<U>,
  stmt: ts.SwitchStatement,
  unwind: readonly U[],
): boolean {
  const linear = host.linear;
  return lowerSwitchStatement(
    {
      evalToSpill: (expr, u) => planLinearEval(linear, expr, u, "switch"),
      strictEq: (a, b) => planLinearStrictEq(linear, a, b),
      reserve: () => linear.reserve(),
      enter: (id) => linear.enter(id),
      jump: (next) => linear.jump(next),
      branch: (flag, thenState, elseState) => linear.branch(flag, thenState, elseState),
      lowerBody: (statements, u, target) => host.lowerBody(statements, u, target),
    },
    stmt,
    unwind,
    host.takeLabels(),
  );
}

/** §14.12.4 — see the module comment. */
export function lowerSwitchStatement<U>(
  host: SwitchHost<U>,
  stmt: ts.SwitchStatement,
  unwind: readonly U[],
  labels: readonly string[],
): boolean {
  const input = host.evalToSpill(stmt.expression, unwind);
  if (input === undefined) return false;
  const clauses = stmt.caseBlock.clauses;
  const bodies = clauses.map(() => host.reserve());
  const exit = host.reserve();
  let defaultIndex = -1;
  // Source order without the default IS the spec's order: the A clauses (before
  // `default`) are tried first, then the B clauses (after it).
  for (let i = 0; i < clauses.length; i++) {
    const clause = clauses[i]!;
    if (ts.isDefaultClause(clause)) {
      defaultIndex = i;
      continue;
    }
    const selector = host.evalToSpill(clause.expression, unwind);
    if (selector === undefined) return false;
    const miss = host.reserve();
    host.branch(host.strictEq(input, selector), bodies[i]!, miss);
    host.enter(miss);
  }
  host.jump(defaultIndex >= 0 ? bodies[defaultIndex]! : exit);
  const target: JumpTarget = {
    labels,
    isLoop: false,
    unlabelledBreak: true,
    breakState: exit,
    breakDepth: unwind.length,
  };
  for (let i = 0; i < clauses.length; i++) {
    host.enter(bodies[i]!);
    if (!host.lowerBody(clauses[i]!.statements, unwind, target)) return false;
    // Fall through into the next clause's statements (§14.12.4 step 4.d).
    host.jump(i + 1 < clauses.length ? bodies[i + 1]! : exit);
  }
  host.enter(exit);
  return true;
}
