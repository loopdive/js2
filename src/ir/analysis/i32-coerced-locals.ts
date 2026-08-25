// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Pure static analysis: which `let` / `const` locals of a function are provably
 * int32-valued at EVERY write (#1120, hardened by #1236 / #2789 / #1930).
 *
 * Extracted verbatim from `src/codegen/function-body.ts` (#3741) so the IR
 * front-end (`src/ir/from-ast.ts`) can reuse the SAME hardened proof without
 * importing the emit-heavy legacy function-body module — which would create an
 * import cycle (`codegen/index.ts` already imports `ir/`). No CodegenContext,
 * no emission: a `ts.FunctionLikeDeclaration` in, a `Set<string>` out. Same
 * precedent as `src/ir/analysis/loop-shape.ts`, which `from-ast.ts`
 * already imports for `isIncreasingStep` / `loopBodyMutatesIndexOrArray`.
 *
 * (#1930 three-question doctrine.) This is a **Q-CANON** matcher: "is the
 * local's VALUE always exactly a signed int32?" — so `+` / `-` / `*` are
 * deliberately rejected (see the `#1236` comment inside `isI32SafeExpr`). Do
 * NOT copy arms in from the **Q-WRAP** matchers (`binary-ops.ts`'s
 * `isI32PureExpr`, `ir/from-ast.ts`'s `isI32WrapLowerable`), which answer the
 * different question "may this be evaluated in i32 GIVEN an enclosing ToInt32?"
 */
import { forEachChild, ts } from "../../ts-api.js";

/**
 * #1120: Detect locals that should be allocated as `i32` instead of `f64`
 * because every value flowing through them is constrained to a 32-bit
 * signed integer by explicit `| 0` (or other bitwise) coercion.
 *
 * The classic pattern, from the iterative Fibonacci benchmark, is:
 *
 *     let a = 0;
 *     let b = 1;
 *     for (let i = 0; i < n; i++) {
 *       const next = (a + b) | 0;   // every write is ToInt32-coerced
 *       a = b;
 *       b = next;
 *     }
 *
 * Each of `a`, `b`, and `next` only ever holds an int32, so allocating
 * them as f64 forces the compiler into a heavy `f64 -> ToInt32 -> f64`
 * round-trip on every iteration. By proving they are i32 we let the
 * binary-op layer collapse the loop body to native i32 arithmetic.
 *
 * Detection rules (conservative; any rule failing leaves the local as f64):
 *   1. Declared via `let` or `const` (not `var`, not module-global, not param).
 *   2. Initializer is i32-safe (see `isI32SafeExpr`).
 *   3. Every assignment / compound-assignment / increment/decrement to the
 *      local also produces an i32-safe value.
 *
 * The set is fixpoint-iterated because membership of one local can depend
 * on membership of another (e.g. `a = b; b = next;` requires all three
 * to reach the i32 set together).
 */
export function collectI32CoercedLocals(decl: ts.FunctionLikeDeclaration): Set<string> {
  const i32Set = new Set<string>();
  if (!decl.body || !ts.isBlock(decl.body)) return i32Set;

  // Map of candidate name -> initializer + every later mutation
  type Mutation =
    | { kind: "init"; expr: ts.Expression | undefined }
    | { kind: "assign"; expr: ts.Expression }
    | { kind: "compound"; op: ts.SyntaxKind; rhs: ts.Expression }
    | { kind: "incdec" };
  const candidates = new Map<string, Mutation[]>();
  // Names of for-loop counters that the existing detectI32LoopVar already
  // promotes (see statements/loops.ts). We respect those by adding them
  // to i32Set unconditionally so other locals can depend on them.
  const forCounterCandidates = new Set<string>();

  function recordCandidate(name: string, m: Mutation): void {
    let list = candidates.get(name);
    if (!list) {
      list = [];
      candidates.set(name, list);
    }
    list.push(m);
  }

  // Names declared more than once across the function body. Shadowing
  // (e.g. an outer `let y = 2` and a block-scoped `let y`) breaks our
  // by-name candidate model: the hoisting pre-pass and the per-scope
  // codegen would see different types for the same name. Drop these
  // names entirely to keep correctness.
  const shadowedNames = new Set<string>();

  // Pass 1: collect declarations
  function collectDecls(node: ts.Node): void {
    // Skip nested functions — their locals are independent
    if (
      node !== decl &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isAccessor(node) ||
        ts.isConstructorDeclaration(node))
    ) {
      return;
    }
    if (ts.isVariableStatement(node)) {
      const isLetConst = (node.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0;
      if (isLetConst) {
        for (const v of node.declarationList.declarations) {
          if (ts.isIdentifier(v.name)) {
            const nm = v.name.text;
            if (candidates.has(nm)) {
              shadowedNames.add(nm);
            } else {
              recordCandidate(nm, { kind: "init", expr: v.initializer });
            }
          }
        }
      }
    } else if (ts.isForStatement(node) && node.initializer && ts.isVariableDeclarationList(node.initializer)) {
      const isLetConst = (node.initializer.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0;
      if (isLetConst) {
        for (const v of node.initializer.declarations) {
          if (ts.isIdentifier(v.name) && v.initializer && ts.isNumericLiteral(v.initializer)) {
            // Loop counter pattern — mark the existing i32 promotion as known.
            const init = Number(v.initializer.text.replace(/_/g, ""));
            if (Number.isInteger(init) && init >= -2147483648 && init <= 2147483647) {
              forCounterCandidates.add(v.name.text);
            }
          }
        }
      }
    }
    forEachChild(node, collectDecls);
  }
  forEachChild(decl.body, collectDecls);

  // Drop shadowed names — they are not safe to promote because the
  // hoist/codegen split would see two scopes with the same name.
  for (const nm of shadowedNames) candidates.delete(nm);

  if (candidates.size === 0 && forCounterCandidates.size === 0) return i32Set;

  // Disqualifications: any candidate whose write we cannot prove i32-safe
  // — destructuring assignment, for-of/for-in iteration, etc.
  const disqualified = new Set<string>();

  /** Walk an AssignmentTarget (LHS of `[…] = …` / `{…} = …`) and disqualify
   * every candidate identifier inside. Destructuring writes opaque
   * element/property values that we cannot structurally prove to fit in
   * int32. */
  function disqualifyFromTarget(target: ts.Expression): void {
    if (ts.isParenthesizedExpression(target)) {
      disqualifyFromTarget(target.expression);
      return;
    }
    if (ts.isIdentifier(target)) {
      if (candidates.has(target.text)) disqualified.add(target.text);
      return;
    }
    if (ts.isArrayLiteralExpression(target)) {
      for (const el of target.elements) {
        if (ts.isOmittedExpression(el)) continue;
        if (ts.isSpreadElement(el)) {
          disqualifyFromTarget(el.expression);
          continue;
        }
        if (ts.isBinaryExpression(el) && el.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          // target with default: `[a = 0] = ...`
          disqualifyFromTarget(el.left);
          continue;
        }
        disqualifyFromTarget(el);
      }
      return;
    }
    if (ts.isObjectLiteralExpression(target)) {
      for (const prop of target.properties) {
        if (ts.isPropertyAssignment(prop)) {
          disqualifyFromTarget(prop.initializer);
        } else if (ts.isShorthandPropertyAssignment(prop)) {
          if (candidates.has(prop.name.text)) disqualified.add(prop.name.text);
        } else if (ts.isSpreadAssignment(prop)) {
          disqualifyFromTarget(prop.expression);
        }
      }
      return;
    }
    // PropertyAccessExpression / ElementAccessExpression: the assignment
    // is into a member, not into a candidate identifier itself.
  }

  // Pass 1.5: scan nested functions for any reference to a candidate.
  // If a candidate is captured by a nested function (regular function /
  // function-expression / arrow / method / accessor / constructor), the
  // closure-construction code uses the candidate's *current* declared
  // type to build the capture struct. Promoting the local to i32
  // afterwards would not retroactively rewrite the read sites inside
  // those nested closures, leading to mid-expression i32 reads in an
  // f64 numeric context — Wasm validation failure (see #1120 regress
  // cases like the `for await` test where a let in the wrapper is
  // captured by an inner async function).
  function collectCaptures(node: ts.Node, insideNested: boolean): void {
    if (
      node !== decl &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isAccessor(node) ||
        ts.isConstructorDeclaration(node))
    ) {
      // Descend, but mark all identifier references inside as "captured".
      forEachChild(node, (child) => collectCaptures(child, true));
      return;
    }
    if (insideNested && ts.isIdentifier(node) && candidates.has(node.text)) {
      disqualified.add(node.text);
    }
    forEachChild(node, (child) => collectCaptures(child, insideNested));
  }
  forEachChild(decl.body, (child) => collectCaptures(child, false));

  // Pass 2: collect every mutation of each candidate
  function collectMutations(node: ts.Node): void {
    if (
      node !== decl &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isAccessor(node) ||
        ts.isConstructorDeclaration(node))
    ) {
      return;
    }

    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      // Destructuring assignment: LHS is an array/object literal pattern.
      if (
        op === ts.SyntaxKind.EqualsToken &&
        (ts.isArrayLiteralExpression(node.left) || ts.isObjectLiteralExpression(node.left))
      ) {
        disqualifyFromTarget(node.left);
      } else if (ts.isIdentifier(node.left)) {
        const name = node.left.text;
        if (op === ts.SyntaxKind.EqualsToken && candidates.has(name)) {
          recordCandidate(name, { kind: "assign", expr: node.right });
        } else if (
          candidates.has(name) &&
          (op === ts.SyntaxKind.PlusEqualsToken ||
            op === ts.SyntaxKind.MinusEqualsToken ||
            op === ts.SyntaxKind.AsteriskEqualsToken ||
            op === ts.SyntaxKind.AmpersandEqualsToken ||
            op === ts.SyntaxKind.BarEqualsToken ||
            op === ts.SyntaxKind.CaretEqualsToken ||
            op === ts.SyntaxKind.LessThanLessThanEqualsToken ||
            op === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
            op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken)
        ) {
          recordCandidate(name, { kind: "compound", op, rhs: node.right });
        }
      }
    }
    // for-of / for-in: writes into the loop variable each iteration with
    // an opaque element/key value. Disqualify any candidate written this
    // way. (For `for (let x of …)` x is a fresh let-decl; not a previously
    // collected candidate.)
    if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
      const init = node.initializer;
      if (init && ts.isIdentifier(init) && candidates.has(init.text)) {
        disqualified.add(init.text);
      }
      if (init && (ts.isArrayLiteralExpression(init) || ts.isObjectLiteralExpression(init))) {
        disqualifyFromTarget(init);
      }
    }
    if (
      (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      ts.isIdentifier(node.operand) &&
      candidates.has(node.operand.text)
    ) {
      recordCandidate(node.operand.text, { kind: "incdec" });
    }
    forEachChild(node, collectMutations);
  }
  forEachChild(decl.body, collectMutations);

  // Drop disqualified candidates so they cannot be promoted.
  for (const name of disqualified) {
    candidates.delete(name);
  }

  /**
   * Returns true iff `expr` evaluates to a value whose ToInt32 coercion
   * would be the identity — i.e. the value is already representable as
   * a signed 32-bit integer. This is what lets us promote the receiving
   * local to i32 without changing the program's observable values.
   *
   * Recognised i32-safe forms:
   *   • integer-literal in the i32 range
   *   • a reference to another candidate that is currently in `i32Set`
   *   • a reference to a known for-loop counter (already i32 in codegen)
   *   • any bitwise binary op (`|`, `&`, `^`, `<<`, `>>`, `>>>`) — by
   *     definition produces an int32
   *   • any comparison op (`<`, `<=`, `>`, `>=`) — produces a boolean
   *     (i32 0/1)
   *   • `+`, `-`, `*` of two i32-safe operands (overflow wrap is OK
   *     because the receiving local is i32 and any consumer that
   *     expects f64 will use coerceType to widen)
   *   • unary `-`/`+`/`~` of an i32-safe operand
   *   • a parenthesised / `as`-cast / non-null-asserted i32-safe expr
   */
  // Depth guard: identical to the one in inferNumericReturnTypes — if a
  // candidate's initializer / mutation tree is deeper than this, we
  // conservatively treat it as not-safe rather than recursing further.
  const MAX_I32_SAFE_DEPTH = 64;
  function isI32SafeExpr(expr: ts.Expression | undefined, depth = 0): boolean {
    if (depth > MAX_I32_SAFE_DEPTH) return false;
    if (!expr) return true; // no initializer → 0 (which is i32)
    if (ts.isParenthesizedExpression(expr)) return isI32SafeExpr(expr.expression, depth + 1);
    if (ts.isAsExpression(expr) || ts.isTypeAssertionExpression(expr) || ts.isNonNullExpression(expr)) {
      return isI32SafeExpr(expr.expression, depth + 1);
    }
    if (ts.isNumericLiteral(expr)) {
      const v = Number(expr.text.replace(/_/g, ""));
      return Number.isInteger(v) && v >= -2147483648 && v <= 2147483647;
    }
    if (ts.isPrefixUnaryExpression(expr)) {
      const o = expr.operator;
      if (o === ts.SyntaxKind.PlusToken || o === ts.SyntaxKind.TildeToken) {
        return isI32SafeExpr(expr.operand, depth + 1);
      }
      // (#1930 Slice 3, divergence verdict V1 — the #2789 fix propagated to
      // the SCALAR lane.) Unary `-` can produce negative zero: `let y = -x`
      // with `x === 0` is spec `-0`, which an i32 local collapses to `+0`
      // (observable via `Object.is(y, -0)` / sign-of-zero reads). This arm
      // previously accepted ANY i32-safe operand — violating this matcher's
      // own documented canonical contract ("not -0", header lines above) and
      // diverging from `isI32SafeExprForArray`, which was fixed in #2789.
      // Mirror that fix exactly: admit ONLY `-<non-zero integer literal>` —
      // a constant sentinel like `-1` with no `-0` hazard. Strict subset of
      // the prior acceptance ⇒ can only DEMOTE candidates to f64 (sound,
      // same direction as #1236/#2789).
      if (o === ts.SyntaxKind.MinusToken) {
        if (!ts.isNumericLiteral(expr.operand)) return false;
        if (!isI32SafeExpr(expr.operand, depth + 1)) return false;
        return Number(expr.operand.text.replace(/_/g, "")) !== 0;
      }
      if (o === ts.SyntaxKind.PlusPlusToken || o === ts.SyntaxKind.MinusMinusToken) {
        return (
          ts.isIdentifier(expr.operand) &&
          (i32Set.has(expr.operand.text) || forCounterCandidates.has(expr.operand.text))
        );
      }
      return false;
    }
    if (ts.isPostfixUnaryExpression(expr)) {
      // x++ / x-- as expression (rare): rely on the operand being i32-safe
      return (
        ts.isIdentifier(expr.operand) && (i32Set.has(expr.operand.text) || forCounterCandidates.has(expr.operand.text))
      );
    }
    if (ts.isIdentifier(expr)) {
      return i32Set.has(expr.text) || forCounterCandidates.has(expr.text);
    }
    if (ts.isBinaryExpression(expr)) {
      const o = expr.operatorToken.kind;
      // Bitwise / shift always produce int32 (signed for all but `>>>` —
      // see #1120 follow-up: `>>>` returns uint32 which can sit above
      // 2^31, so when the receiving local is consumed as f64 the i32
      // promotion would change the observable value. Conservatively
      // exclude `>>>`.
      if (
        o === ts.SyntaxKind.BarToken ||
        o === ts.SyntaxKind.AmpersandToken ||
        o === ts.SyntaxKind.CaretToken ||
        o === ts.SyntaxKind.LessThanLessThanToken ||
        o === ts.SyntaxKind.GreaterThanGreaterThanToken
      ) {
        return true;
      }
      // Comparison → boolean (i32)
      if (
        o === ts.SyntaxKind.LessThanToken ||
        o === ts.SyntaxKind.LessThanEqualsToken ||
        o === ts.SyntaxKind.GreaterThanToken ||
        o === ts.SyntaxKind.GreaterThanEqualsToken
      ) {
        return true;
      }
      // #1236 — `+`, `-`, `*` of i32-safe operands are NOT safe to promote
      // to i32 here. The arithmetic itself produces f64 in codegen (JS spec:
      // `number + number` is f64), and the trailing `i32.trunc_sat_f64_s`
      // saturates rather than wrapping when the result exceeds 2^31-1.
      // Pre-#1236 logic accepted these as safe ("overflow wrap is OK") but
      // saturation is silent corruption: a long-running accumulator
      // (`let s = 0; for (let i = 0; i < 1e6; i++) s = s + i;`) returns
      // 2147483647 instead of the spec-correct 499999500000. Demote the
      // candidate to f64 instead — the f64 arithmetic now flows through
      // an f64 local with no trunc-sat in sight.
      //
      // Loop counters (`for (let i = 0; ...; i++)`) are unaffected: they go
      // through the separate `detectI32LoopVar` path which proves the
      // counter is bounded by the loop condition.
      if (o === ts.SyntaxKind.PlusToken || o === ts.SyntaxKind.MinusToken || o === ts.SyntaxKind.AsteriskToken) {
        return false;
      }
      return false;
    }
    return false;
  }

  /** Compound assignment is i32-safe if RHS is i32-safe (the result wraps to int32 in JS for bitwise/shift compounds, and for +=/-=/*= it requires the local to stay int32 for both the read and the write). */
  function isCompoundI32Safe(op: ts.SyntaxKind, rhs: ts.Expression): boolean {
    // Bitwise compound: always i32
    if (
      op === ts.SyntaxKind.AmpersandEqualsToken ||
      op === ts.SyntaxKind.BarEqualsToken ||
      op === ts.SyntaxKind.CaretEqualsToken ||
      op === ts.SyntaxKind.LessThanLessThanEqualsToken ||
      op === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
      op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken
    ) {
      return true;
    }
    // #1236 — `+=`, `-=`, `*=` desugar to `lhs = lhs + rhs` etc., which
    // routes through f64 arithmetic and a trailing `i32.trunc_sat_f64_s`.
    // Saturation on overflow silently corrupts long-running accumulators
    // (see #1236 / Option A). Demote to f64 instead.
    if (
      op === ts.SyntaxKind.PlusEqualsToken ||
      op === ts.SyntaxKind.MinusEqualsToken ||
      op === ts.SyntaxKind.AsteriskEqualsToken
    ) {
      return false;
    }
    return false;
  }

  // Initial set: every candidate goes in. We then iteratively remove any
  // that fail the safety check until the set stops shrinking.
  for (const name of candidates.keys()) i32Set.add(name);

  let changed = true;
  let safety = candidates.size + 2;
  while (changed && safety-- > 0) {
    changed = false;
    for (const [name, muts] of candidates) {
      if (!i32Set.has(name)) continue;
      let safe = true;
      for (const m of muts) {
        if (m.kind === "init") {
          if (!isI32SafeExpr(m.expr)) {
            safe = false;
            break;
          }
        } else if (m.kind === "assign") {
          if (!isI32SafeExpr(m.expr)) {
            safe = false;
            break;
          }
        } else if (m.kind === "compound") {
          if (!isCompoundI32Safe(m.op, m.rhs)) {
            safe = false;
            break;
          }
        }
        // incdec is always i32-safe (operand is the local itself, already a candidate)
      }
      if (!safe) {
        i32Set.delete(name);
        changed = true;
      }
    }
  }

  return i32Set;
}
