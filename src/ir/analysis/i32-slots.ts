// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3741) Which mutable numeric locals of an IR-lowered function should be
 * STORED as a native `i32` Wasm local instead of `f64`.
 *
 * ## Why this exists
 *
 * The landing-page `loop.ts` benchmark
 *
 *     let s = 0;
 *     for (let i = 0; i < 1000000; i++) s = (s + i) | 0;
 *
 * runs ~16x slower through the IR front-end than through legacy AST-direct
 * codegen. Legacy has had a dedicated promotion since #1120
 * (`collectI32CoercedLocals`) plus the for-counter promotion `detectI32LoopVar`,
 * which together collapse that loop to `i32.add` / `i32.lt_s`. The IR front-end
 * had no equivalent, so every iteration paid an f64 add plus a ~25-instruction
 * JS-ToInt32 bit-manipulation sequence.
 *
 * ## Why *storage*, and not just cheaper ToInt32
 *
 * Measured on the exact benchmark (hand-written `.wat`, node/V8, 1M iterations):
 *
 *   | shape                                                    | median  |
 *   |----------------------------------------------------------|---------|
 *   | both locals `i32` (legacy)                                |  0.41ms |
 *   | both `i32`, f64 view only at the loop condition           |  0.70ms |
 *   | accumulator `i32`, counter `f64`                          |  1.88ms |
 *   | both `f64`, cheap `trunc`/`i32.add`/`convert` per iter    |  7.25ms |
 *   | both `f64`, `f64.add` + `i64.trunc`/`wrap` per iter       |  6.10ms |
 *
 * i.e. **a loop-carried `f64 -> i32 -> f64` round trip costs as much as the
 * whole ToInt32 sequence it replaces**. Making ToInt32 cheaper while leaving the
 * local in an f64 slot buys nothing. The storage kind is the lever.
 *
 * ## Why this is contained (and the previous attempt was not)
 *
 * An earlier #3741 attempt retyped the local's *`IrType`* to i32, which changed
 * what EVERY consumer in `from-ast.ts` observed (array stores, Map slots, early
 * returns, closure captures, …) and produced 13 unrelated failures. This plan
 * instead keeps `ScopeBinding.type` at **f64** — the binding's logical type is
 * unchanged — and only swaps the underlying Wasm slot's ValType. Reads of a
 * promoted slot emit `slot.read` (i32) + `f64.convert_i32_s`, so the SSA value
 * handed to every consumer is f64-typed exactly as before. Only the ~6 sites in
 * `from-ast.ts` that touch a slot *directly* (`readNumericSlot` /
 * `writeNumericSlot`) know about the promotion, plus opt-in fused fast paths
 * that are pure peepholes (they only ever replace a value with a provably
 * bit-identical one of the SAME IrType).
 *
 * ## The proof obligations
 *
 * A promoted slot must satisfy BOTH:
 *   1. **Q-CANON** — the local's VALUE is always exactly a signed int32, so
 *      storing it as i32 and widening on read with `f64.convert_i32_s` is the
 *      identity. This is exactly `collectI32CoercedLocals` (#1120/#1236/#2789),
 *      reused verbatim from legacy; for-loop counters use `detectI32LoopVar`,
 *      also reused verbatim.
 *   2. **Producible** — every write site must be lowerable to an exact i32 by
 *      `from-ast.ts`'s `lowerCanonI32`. This is a structural check on the write
 *      shapes (see `writeShapesAreLowerable` below); a name that fails it is
 *      simply NOT promoted, so the function still compiles exactly as today (no
 *      new legacy fallback, no fallback-budget growth).
 */
import { forEachChild, ts } from "../../ts-api.js";
import type { IrBinop } from "../nodes.js";
import { collectI32CoercedLocals } from "./i32-coerced-locals.js";
import { detectI32LoopVar } from "./loop-shape.js";

const I32_MIN = -2147483648;
const I32_MAX = 2147483647;

/**
 * "Is this name currently bound to an i32-promoted slot?" The planner answers
 * from its own candidate set; `from-ast.ts` answers from the live `cx.scope`,
 * so an inner shadowing binding can never be mistaken for the promoted one.
 */
export type IsPromotedI32 = (id: ts.Identifier) => boolean;

/** Peel parens / `as` casts / `!` assertions. */
export function peelExpr(e: ts.Expression): ts.Expression {
  let inner: ts.Expression = e;
  for (;;) {
    if (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) || ts.isNonNullExpression(inner)) {
      inner = inner.expression;
      continue;
    }
    if (ts.isTypeAssertionExpression(inner)) {
      inner = inner.expression;
      continue;
    }
    return inner;
  }
}

/** `expr` is an integer literal that fits in a signed 32-bit int. */
export function i32LiteralValue(e: ts.Expression): number | null {
  const inner = peelExpr(e);
  if (ts.isNumericLiteral(inner)) {
    const n = Number(inner.text.replace(/_/g, ""));
    return Number.isInteger(n) && n >= I32_MIN && n <= I32_MAX ? n : null;
  }
  // `-<literal>`: only NON-ZERO, because `-0` is observable in JS and an i32
  // local collapses it to `+0` (the #2789 / #1930-V1 rule).
  if (
    ts.isPrefixUnaryExpression(inner) &&
    inner.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(inner.operand)
  ) {
    const n = Number(inner.operand.text.replace(/_/g, ""));
    if (!Number.isInteger(n) || n === 0) return null;
    const v = -n;
    return v >= I32_MIN && v <= I32_MAX ? v : null;
  }
  return null;
}

export function isBitwiseToken(k: ts.SyntaxKind): boolean {
  return (
    k === ts.SyntaxKind.AmpersandToken ||
    k === ts.SyntaxKind.BarToken ||
    k === ts.SyntaxKind.CaretToken ||
    k === ts.SyntaxKind.LessThanLessThanToken ||
    k === ts.SyntaxKind.GreaterThanGreaterThanToken
    // `>>>` deliberately excluded from the CANON set: it yields a uint32 whose
    // VALUE can exceed 2^31-1, which an i32 local cannot hold (#1120 follow-up).
  );
}

function isComparisonToken(k: ts.SyntaxKind): boolean {
  return (
    k === ts.SyntaxKind.LessThanToken ||
    k === ts.SyntaxKind.LessThanEqualsToken ||
    k === ts.SyntaxKind.GreaterThanToken ||
    k === ts.SyntaxKind.GreaterThanEqualsToken
  );
}

/**
 * Structural mirror of `from-ast.ts`'s `lowerCanonI32`: can this expression be
 * emitted DIRECTLY as an exact i32 value?
 *
 * (#1930 doctrine.) This is the **Q-CANON** question ("is the value exactly a
 * signed int32?"). It deliberately rejects `+` / `-` / `*` — those are only
 * i32-exact under an enclosing ToInt32, which is the separate **Q-WRAP**
 * question answered by `isWrapI32Lowerable`.
 */
export function isCanonI32Lowerable(e: ts.Expression, promoted: IsPromotedI32, depth = 0): boolean {
  if (depth > 64) return false;
  const inner = peelExpr(e);
  if (i32LiteralValue(inner) !== null) return true;
  if (ts.isIdentifier(inner)) return promoted(inner);
  if (ts.isBinaryExpression(inner)) {
    const k = inner.operatorToken.kind;
    // Bitwise (minus `>>>`) always yields an exact int32 regardless of operands.
    if (isBitwiseToken(k)) return true;
    // Magnitude comparisons yield an i32 0/1 in every from-ast arm (f64, i32,
    // string-relational fold, dynamic-relational). `===`/`!==` are deliberately
    // NOT accepted — legacy's Q-CANON matcher excludes them too, and their
    // from-ast lowering has externref arms that throw rather than yield i32.
    if (isComparisonToken(k)) return true;
  }
  return false;
}

/**
 * **Q-WRAP** matcher: may this expression be EVALUATED in i32 such that the
 * result is bit-identical to `ToInt32(spec value)` — GIVEN that the caller
 * guarantees an enclosing ToInt32 (a bitwise operator, or a store into an
 * i32-promoted slot)?
 *
 * Mirrors legacy `binary-ops.ts`'s `isI32PureExpr` minus its `*` arm: `+` / `-`
 * of two int32-range operands are exact in f64 (|a ± b| < 2^32 < 2^53), so the
 * `i32.add` / `i32.sub` wrap equals `ToInt32(f64 result)`. `*` is NOT included —
 * an i32 x i32 product can need 62 bits, which f64 rounds, so `i32.mul` and
 * `ToInt32(f64.mul(..))` genuinely disagree (legacy guards it with a
 * `|operand| < 2^21` proof; out of scope for #3741).
 */
export function isWrapI32Lowerable(e: ts.Expression, promoted: IsPromotedI32, depth = 0): boolean {
  if (depth > 64) return false;
  const inner = peelExpr(e);
  if (isCanonI32Lowerable(inner, promoted, depth)) return true;
  if (ts.isBinaryExpression(inner)) {
    const k = inner.operatorToken.kind;
    if (k === ts.SyntaxKind.PlusToken || k === ts.SyntaxKind.MinusToken) {
      return (
        isWrapI32Lowerable(inner.left, promoted, depth + 1) && isWrapI32Lowerable(inner.right, promoted, depth + 1)
      );
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// The planner: WHICH declarations get an i32 slot
//
// Keyed on the DECLARATION NODE, never on the identifier text. Two sibling
// `for (let i = …)` loops are two distinct bindings that happen to share a
// name; a name-keyed set has to reject both to stay safe, which silently
// disables the optimization on one of the most common shapes in real code
// (`for (let i …) …; for (let i …) …`). Legacy does not have that problem
// because its own promotion is applied per-loop at emit time; the IR port
// has to reproduce that by resolving each candidate to its binding.
// ---------------------------------------------------------------------------

function isFunctionLikeNode(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isAccessor(node) ||
    ts.isConstructorDeclaration(node)
  );
}

/** `inner` lies inside `outer`'s source range (same file, real nodes only). */
function nodeContains(outer: ts.Node, inner: ts.Node): boolean {
  return outer.pos <= inner.pos && inner.end <= outer.end;
}

/**
 * The subtree a `let`/`const` declaration's binding is visible in.
 *
 * For a `for` head the binding's scope is the ForStatement itself (head +
 * body), which is exactly what makes two SIBLING loops' counters disjoint.
 * For a plain `let` it is the innermost enclosing block-like node.
 */
function declarationScope(d: ts.VariableDeclaration): ts.Node {
  const owner = d.parent.parent;
  if (ts.isForStatement(owner) || ts.isForOfStatement(owner) || ts.isForInStatement(owner)) return owner;
  let cur: ts.Node | undefined = owner.parent;
  while (cur) {
    if (ts.isBlock(cur) || ts.isSourceFile(cur) || ts.isCaseBlock(cur) || ts.isModuleBlock(cur)) return cur;
    cur = cur.parent;
  }
  return owner;
}

/** Every `let`/`const`/`var` declaration and parameter name in `fn`'s own scope. */
function collectDeclarationSites(fn: ts.FunctionLikeDeclaration): {
  readonly byName: ReadonlyMap<string, readonly ts.VariableDeclaration[]>;
  readonly paramNames: ReadonlySet<string>;
} {
  const byName = new Map<string, ts.VariableDeclaration[]>();
  const paramNames = new Set<string>();
  for (const p of fn.parameters) {
    if (ts.isIdentifier(p.name)) paramNames.add(p.name.text);
  }
  const walk = (node: ts.Node): void => {
    if (node !== fn && isFunctionLikeNode(node)) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const list = byName.get(node.name.text);
      if (list) list.push(node);
      else byName.set(node.name.text, [node]);
    }
    forEachChild(node, walk);
  };
  if (fn.body) forEachChild(fn.body, walk);
  return { byName, paramNames };
}

/** Walk `scope`, skipping nested functions and any sibling binding's scope. */
function walkBindingScope(scope: ts.Node, excluded: readonly ts.Node[], visit: (node: ts.Node) => void): void {
  const walk = (node: ts.Node): void => {
    if (node !== scope && isFunctionLikeNode(node)) return;
    if (node !== scope && excluded.some((e) => e === node)) return;
    visit(node);
    forEachChild(node, walk);
  };
  walk(scope);
}

/** `name` is read from inside a nested function anywhere in `scope`. */
function isCapturedByNestedFunction(scope: ts.Node, name: string): boolean {
  let captured = false;
  const walk = (node: ts.Node, insideNested: boolean): void => {
    if (captured) return;
    if (node !== scope && isFunctionLikeNode(node)) {
      forEachChild(node, (c) => walk(c, true));
      return;
    }
    if (insideNested && ts.isIdentifier(node) && node.text === name) {
      captured = true;
      return;
    }
    forEachChild(node, (c) => walk(c, insideNested));
  };
  walk(scope, false);
  return captured;
}

const COMPOUND_ASSIGN_TOKENS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

/** `x++` whose result value is discarded (statement / for-incrementor). */
function isDiscardedIncDecPosition(node: ts.Node): boolean {
  const p = node.parent;
  if (!p) return false;
  if (ts.isExpressionStatement(p)) return true;
  if (ts.isForStatement(p) && p.incrementor === node) return true;
  return false;
}

/**
 * Every write to `d`'s binding must be a shape `lowerAsI32` can emit exactly.
 * Scanned over `d`'s own scope only, so a same-named sibling binding's writes
 * are never attributed here.
 */
function writeShapesAreLowerable(
  d: ts.VariableDeclaration,
  scope: ts.Node,
  excluded: readonly ts.Node[],
  promoted: IsPromotedI32,
  isProvenCounter: boolean,
): boolean {
  const name = (d.name as ts.Identifier).text;
  // Declaration: the initializer must be exactly-i32 lowerable. A missing
  // initializer (`let x;`) is not promotable — the IR's `undefined` init path
  // is unrelated to numeric slots.
  if (!d.initializer || !isCanonI32Lowerable(d.initializer, promoted)) return false;

  let ok = true;
  walkBindingScope(scope, excluded, (node) => {
    if (!ok) return;
    if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left) && node.left.text === name) {
      const k = node.operatorToken.kind;
      if (k === ts.SyntaxKind.EqualsToken) {
        // (#3907) `i = i + <int literal>` on a `detectI32LoopVar`-proven counter
        // is the SAME operation as the `i += <int literal>` arm below, just
        // spelled out; it carries the identical bounded-by-the-loop-condition
        // proof. Before #3907 fast mode narrowed every `number` regardless, so
        // the spelling never mattered; with the blanket narrowing gone this
        // form silently demoted the counter to f64 — and it is the spelling the
        // whole benchmark suite uses (`for (let i = 0; i < N; i = i + 1)`).
        // Deliberately NOT extended to a general accumulator: the counter proof
        // is what makes it sound, exactly as in the `+=` arm (#1236 trap).
        if (!(isProvenCounter && isCounterStepAssignment(node.right, name))) {
          if (!isCanonI32Lowerable(node.right, promoted)) ok = false;
        }
      } else if (
        k === ts.SyntaxKind.AmpersandEqualsToken ||
        k === ts.SyntaxKind.BarEqualsToken ||
        k === ts.SyntaxKind.CaretEqualsToken ||
        k === ts.SyntaxKind.LessThanLessThanEqualsToken ||
        k === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken
      ) {
        // Bitwise compound assignment always yields an exact int32.
      } else if (
        (k === ts.SyntaxKind.PlusEqualsToken || k === ts.SyntaxKind.MinusEqualsToken) &&
        isProvenCounter &&
        i32LiteralValue(node.right) !== null
      ) {
        // `i += <int literal>` on a `detectI32LoopVar`-proven counter — the same
        // bounded-by-the-loop-condition step legacy promotes. NOT accepted for a
        // general accumulator (that is exactly the #1236 saturation trap).
      } else if (COMPOUND_ASSIGN_TOKENS.has(k)) {
        ok = false;
      }
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      ts.isIdentifier(node.operand) &&
      node.operand.text === name
    ) {
      // `x++` / `--x` lower to `i32.add`/`i32.sub` of 1 — the same wrap legacy
      // has emitted for promoted locals since #1120. from-ast only lowers these
      // in result-discarding position (`lowerIncrementDecrement` returns void),
      // so require the same shape here.
      if (!isDiscardedIncDecPosition(node)) ok = false;
    }
  });
  return ok;
}

/**
 * (#3907) `<counter> = <counter> +|- <int literal>` — the desugared spelling of
 * the `<counter> +=|-= <int literal>` step. Accepted ONLY for a
 * `detectI32LoopVar`-proven counter, where the loop condition bounds the value;
 * see the call sites in `writeShapesAreLowerable` and `writePromotedI32Slot`.
 * Returns the step as `{ op, step }`, or null when the shape does not match.
 */
export function counterStepAssignment(
  rhs: ts.Expression,
  counterName: string,
): { readonly negate: boolean; readonly step: number } | null {
  const inner = peelExpr(rhs);
  if (!ts.isBinaryExpression(inner)) return null;
  const k = inner.operatorToken.kind;
  if (k !== ts.SyntaxKind.PlusToken && k !== ts.SyntaxKind.MinusToken) return null;
  const left = peelExpr(inner.left);
  if (!ts.isIdentifier(left) || left.text !== counterName) return null;
  const step = i32LiteralValue(inner.right);
  if (step === null) return null;
  return { negate: k === ts.SyntaxKind.MinusToken, step };
}

function isCounterStepAssignment(rhs: ts.Expression, counterName: string): boolean {
  return counterStepAssignment(rhs, counterName) !== null;
}

/** One promotion candidate: a declaration plus its resolved binding scope. */
interface Candidate {
  readonly decl: ts.VariableDeclaration;
  readonly name: string;
  readonly scope: ts.Node;
  /** Same-name sibling scopes to skip when scanning (always disjoint). */
  readonly siblingScopes: readonly ts.Node[];
  /** Proven by `detectI32LoopVar` (unlocks the `i += <lit>` step shape). */
  readonly isProvenCounter: boolean;
}

/**
 * Plan which slot-bound locals of `fn` get native i32 storage.
 *
 * `mutatedLets` is from-ast's own "this name is reassigned somewhere" set —
 * only those names get a slot at all, so only those can be promoted.
 *
 * Returns the set of DECLARATION NODES (not names): `from-ast.ts` matches on
 * node identity at `lowerVarDecl`, and every read/write already resolves
 * through `cx.scope`, so shadowing can never mis-target a promotion.
 */
export function planI32Slots(
  fn: ts.FunctionLikeDeclaration,
  mutatedLets: ReadonlySet<string>,
): ReadonlySet<ts.VariableDeclaration> {
  if (!fn.body || !ts.isBlock(fn.body) || mutatedLets.size === 0) return EMPTY;

  // (1) Q-CANON — legacy's hardened value proof, reused verbatim. Name-keyed,
  // and it already drops any name declared twice among `VariableStatement`s.
  const canonNames = collectI32CoercedLocals(fn);

  // (1b) for-loop counters, via legacy's `detectI32LoopVar` (also verbatim).
  // `collectI32CoercedLocals` deliberately does NOT return these (it only
  // records them as dependencies) because legacy promotes them through the
  // separate loop path.
  const counterDecls = new Set<ts.VariableDeclaration>();
  const collectCounters = (node: ts.Node): void => {
    if (node !== fn && isFunctionLikeNode(node)) return;
    if (ts.isForStatement(node)) {
      const info = detectI32LoopVar(node);
      const init = node.initializer;
      if (info && init && ts.isVariableDeclarationList(init) && init.declarations.length === 1) {
        counterDecls.add(init.declarations[0]!);
      }
    }
    forEachChild(node, collectCounters);
  };
  forEachChild(fn.body, collectCounters);

  const { byName, paramNames } = collectDeclarationSites(fn);

  // (2) Build candidates, resolving each to its binding scope. A name whose
  // declarations do NOT have pairwise-disjoint scopes (genuine shadowing, e.g.
  // nested `for (let i …)` inside `for (let i …)`, or a counter shadowing an
  // outer `let i`) is dropped wholesale: distinguishing those bindings needs
  // real scope resolution at every use site, and the conservative answer costs
  // nothing on the shapes that matter. Sibling loops ARE disjoint, which is
  // the whole point of keying on the declaration.
  const candidates = new Map<ts.VariableDeclaration, Candidate>();
  for (const [name, decls] of byName) {
    if (!mutatedLets.has(name) || paramNames.has(name)) continue;
    const scopes = decls.map(declarationScope);
    const disjoint = scopes.every((a, i) =>
      scopes.every((b, j) => i === j || (!nodeContains(a, b) && !nodeContains(b, a))),
    );
    if (!disjoint) continue;
    for (let i = 0; i < decls.length; i++) {
      const decl = decls[i]!;
      const isProvenCounter = counterDecls.has(decl);
      // A plain `let` qualifies only through the Q-CANON name proof; a for
      // counter qualifies through `detectI32LoopVar`.
      if (!isProvenCounter && !canonNames.has(name)) continue;
      candidates.set(decl, {
        decl,
        name,
        scope: scopes[i]!,
        siblingScopes: scopes.filter((_, j) => j !== i),
        isProvenCounter,
      });
    }
  }
  if (candidates.size === 0) return EMPTY;

  // (3) Capture guard — a captured binding is read through the closure's
  // capture struct, which is built from the binding's declared type.
  for (const c of [...candidates.values()]) {
    if (isCapturedByNestedFunction(c.scope, c.name)) candidates.delete(c.decl);
  }

  // (4) Producibility fixpoint: shrink until every surviving candidate's writes
  // are all lowerable to an exact i32. Besides the surviving promoted slots,
  // admit names from Q-CANON itself: immutable intermediates such as
  //
  //     const next = (a + b) | 0;
  //     b = next;
  //
  // are provably int32-valued even though they do not need mutable slot
  // storage. `lowerAsI32` can consume those through `i32PureNames`; excluding
  // them here caused the whole Fibonacci cycle (`a`, `b`) to be demoted to
  // f64. `collectI32CoercedLocals` already rejects duplicate/shadowed names, so
  // the name-based half of this probe cannot leak across sibling bindings.
  //
  // The promoted-slot half still resolves a use site to its GOVERNING
  // declaration, so a same-named sibling binding never leaks its promotion
  // into another scope.
  const promotedAt: IsPromotedI32 = (id: ts.Identifier): boolean => {
    for (const c of candidates.values()) {
      if (c.name === id.text && nodeContains(c.scope, id)) return true;
    }
    return canonNames.has(id.text);
  };
  for (;;) {
    let changed = false;
    for (const c of [...candidates.values()]) {
      if (!writeShapesAreLowerable(c.decl, c.scope, c.siblingScopes, promotedAt, c.isProvenCounter)) {
        candidates.delete(c.decl);
        changed = true;
      }
    }
    if (!changed) break;
    if (candidates.size === 0) return EMPTY;
  }

  return candidates.size === 0 ? EMPTY : new Set(candidates.keys());
}

const EMPTY: ReadonlySet<ts.VariableDeclaration> = new Set<ts.VariableDeclaration>();

/**
 * (#3734) An `IsPromotedI32` probe answerable BEFORE lowering starts, built
 * from `planI32Slots`'s own output.
 *
 * `from-ast.ts`'s live probe (`promotedI32Probe`) reads `cx.scope`, so it only
 * exists once lowering reaches a use site. Analyses that must decide something
 * up front — e.g. whether an empty `number[]` may be given an i32 element
 * representation — need the same answer during the pre-pass. This reproduces
 * exactly the containment test `planI32Slots` itself used to reach its
 * fixpoint (name match + the declaration's binding scope contains the use), so
 * the two probes agree by construction on every declaration the planner kept.
 *
 * Consumers must still re-check with the LIVE probe at lowering time and fail
 * closed if it disagrees — this one is a planning aid, not a licence.
 */
export function makePlannedI32Probe(slots: ReadonlySet<ts.VariableDeclaration>): IsPromotedI32 {
  if (slots.size === 0) return () => false;
  const scoped = [...slots].map((decl) => ({
    name: (decl.name as ts.Identifier).text,
    scope: declarationScope(decl),
  }));
  return (id: ts.Identifier): boolean => scoped.some((s) => s.name === id.text && nodeContains(s.scope, id));
}
// ---------------------------------------------------------------------------
// Pure token/op tables shared with `from-ast.ts`'s emitter
// ---------------------------------------------------------------------------

/** The `js.bit*` IrBinop for a bitwise operator token, or null. */
export function jsBitwiseBinop(k: ts.SyntaxKind): IrBinop | null {
  switch (k) {
    case ts.SyntaxKind.AmpersandToken:
      return "js.bitand";
    case ts.SyntaxKind.BarToken:
      return "js.bitor";
    case ts.SyntaxKind.CaretToken:
      return "js.bitxor";
    case ts.SyntaxKind.LessThanLessThanToken:
      return "js.shl";
    case ts.SyntaxKind.GreaterThanGreaterThanToken:
      return "js.shr_s";
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
      return "js.shr_u";
    default:
      return null;
  }
}

/** Signed native i32 magnitude compare for a relational operator token. */
export const I32_COMPARE_BINOPS = {
  [ts.SyntaxKind.LessThanToken]: "i32.lt_s",
  [ts.SyntaxKind.LessThanEqualsToken]: "i32.le_s",
  [ts.SyntaxKind.GreaterThanToken]: "i32.gt_s",
  [ts.SyntaxKind.GreaterThanEqualsToken]: "i32.ge_s",
} as const satisfies Partial<Record<ts.SyntaxKind, IrBinop>>;

/**
 * The plain bitwise operator a bitwise COMPOUND assignment desugars to.
 * `>>>=` is absent for the same reason `>>>` is absent from `isBitwiseToken`.
 */
export const COMPOUND_TO_BITWISE_TOKEN = {
  [ts.SyntaxKind.AmpersandEqualsToken]: ts.SyntaxKind.AmpersandToken,
  [ts.SyntaxKind.BarEqualsToken]: ts.SyntaxKind.BarToken,
  [ts.SyntaxKind.CaretEqualsToken]: ts.SyntaxKind.CaretToken,
  [ts.SyntaxKind.LessThanLessThanEqualsToken]: ts.SyntaxKind.LessThanLessThanToken,
  [ts.SyntaxKind.GreaterThanGreaterThanEqualsToken]: ts.SyntaxKind.GreaterThanGreaterThanToken,
} as const satisfies Partial<Record<ts.SyntaxKind, ts.SyntaxKind>>;

/**
 * Does `e` read at least one i32-promoted slot? This is the gate that keeps
 * #3741's slot-promotion fusion from pre-empting #3758's expression-level
 * fusion on expressions where #3758 does strictly better.
 */
export function referencesPromotedI32Slot(e: ts.Expression, promoted: IsPromotedI32): boolean {
  const inner = peelExpr(e);
  if (ts.isIdentifier(inner)) return promoted(inner);
  if (ts.isBinaryExpression(inner)) {
    return referencesPromotedI32Slot(inner.left, promoted) || referencesPromotedI32Slot(inner.right, promoted);
  }
  return false;
}
