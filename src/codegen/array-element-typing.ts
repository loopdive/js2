// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1197: i32 element specialization for `number[]` arrays.
 *
 * Detects locals declared as `let arr: number[] = []` (or via `new Array(...)` /
 * `Array(...)`) where every element write is i32-shaped (e.g. `arr[i] = (x | 0)`)
 * and every use is local (no closure capture, no escape via function calls,
 * no array methods that assume f64 layout). Such arrays can be lowered to
 * `array<mut i32>` instead of `array<mut f64>`, removing the per-element
 * f64 ↔ i32 round-trip.
 *
 * The result set is consumed by:
 *   1. `statements/variables.ts` — overrides the local's wasm type to ref_null __vec_i32
 *      and sets `_i32ElemArrayOverride` on the ctx so the array literal compiler
 *      emits an i32 backing array.
 *   2. `literals.ts:compileArrayLiteral` / `compileArrayConstructorCall` — read
 *      the override flag and pick `i32` element kind in place of the contextual
 *      type's `f64`.
 *
 * Reads of an i32-element vec naturally produce i32, and `compileExpression`'s
 * built-in coerceType layer handles i32 → f64 promotion at the few read sites
 * that consume the value in a non-i32 context (#1126's existing pattern).
 */
import { ts, forEachChild } from "../ts-api.js";
import type { TypeOracle } from "../checker/oracle.js";
import { staticIntegerRange } from "../ir/analysis/static-numeric-range.js";

/**
 * A deliberately narrow range-backed extension to the structural Q-CANON
 * matcher. Requiring every arithmetic subtree to stay non-negative and within
 * signed i32 both makes its f64 result exact and rules out observable `-0`.
 * This admits bounded counted-loop arithmetic such as
 * `(i * 7919) % 10000` without reopening the overflow/saturation bug fixed by
 * #2789.
 */
function isNonNegativeStaticI32Expression(expr: ts.Expression, oracle: TypeOracle, depth = 0): boolean {
  if (depth > 32) return false;
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  const range = staticIntegerRange({ oracle }, current);
  if (
    range === undefined ||
    range.min < 0 ||
    range.max > 0x7fffffff ||
    Object.is(range.min, -0) ||
    Object.is(range.max, -0)
  ) {
    return false;
  }
  if (ts.isNumericLiteral(current) || ts.isIdentifier(current)) return true;
  if (!ts.isBinaryExpression(current)) return false;
  const operator = current.operatorToken.kind;
  if (
    operator !== ts.SyntaxKind.PlusToken &&
    operator !== ts.SyntaxKind.MinusToken &&
    operator !== ts.SyntaxKind.AsteriskToken &&
    operator !== ts.SyntaxKind.PercentToken
  ) {
    return false;
  }
  return (
    isNonNegativeStaticI32Expression(current.left, oracle, depth + 1) &&
    isNonNegativeStaticI32Expression(current.right, oracle, depth + 1)
  );
}

/**
 * Return true if `expr` provably produces a **canonical** signed-32-bit integer
 * at runtime — a value `v ∈ ℤ ∩ [-2^31, 2^31)` whose f64 image is bit-identical
 * to `v` (so `v` is not `-0`, not fractional, not NaN/±Inf, not `|v| ≥ 2^31`).
 * `i32Locals` is the set of locals already known to hold i32.
 *
 * The "canonical" property is the soundness contract for #2789: when EVERY write
 * to a packed array yields a canonical i32, the i32-stored value read back as f64
 * equals what the f64 backing would have stored, so NO read can observe a
 * distinction i32 erases. That discharges the read-side proof obligation in the
 * hybrid fast-path audit (Row 3) for free — there is no distinction to observe.
 *
 * (#1930 Slice 3 — three-question doctrine.) This is a **Q-CANON** matcher:
 * "is this VALUE a canonical int32 (no observable i32↔f64 divergence,
 * including −0 and overflow)?" — one of the three DISTINCT i32-safety
 * questions the compiler asks (see issue #1930's divergence-verdict table):
 *   Q-CANON  — value canonicality (this matcher + `isI32SafeExpr`,
 *              function-body.ts — the scalar-local sibling, now aligned on
 *              the #2789 unary-minus verdict V1);
 *   Q-WRAP   — evaluate-in-i32 wrap-equivalence UNDER a ToInt32 context
 *              (`isI32PureExpr`/`isI32MulSafe`, binary-ops.ts) — accepts
 *              `+`/`-`/gated `*` and `>>>` that Q-CANON must reject (V2/V3);
 *   Q-TAG    — static JS tag (oracle `isBooleanProducing` /
 *              `isSyntacticallyBooleanExpr`, src/checker/oracle.ts).
 * These CANNOT merge into one predicate — `a + b` is Q-WRAP-safe but
 * Q-CANON-unsafe; `x >>> 1` likewise. Keep changes question-scoped.
 *
 * Recognised canonical-i32 forms (mirrors `isI32SafeExpr` in function-body.ts;
 * intentionally narrow — we err on the side of disqualification):
 *   - integer numeric literal in [-2^31, 2^31)  (always +0, never -0)
 *   - identifier referencing a known-i32 local  (physically i32 ⇒ canonical)
 *   - bitwise `|`, `&`, `^`, `<<`, `>>`  (ECMAScript defines these to yield a
 *     value that equals ToInt32 of itself ⇒ canonical regardless of operands)
 *   - comparison ops (return boolean = i32 0/1)
 *   - `~x` (canonical int32) and unary `+x` of an i32-safe operand
 *   - unary `-<non-zero integer literal>` only (a `-1`-style sentinel) — NOT
 *     `-x` / `-(expr)`, which can be `-0` (#2789)
 *   - parenthesised / `as`-cast / non-null-asserted canonical-i32 expr
 *
 * Deliberately EXCLUDED (would break canonicality → MISCOMPILE if packed):
 *   - `+` / `-` / `*` arithmetic — f64 result stored via `i32.trunc_sat_f64_s`,
 *     which SATURATES on overflow rather than yielding the spec-correct f64
 *     (#2789, mirrors the #1236 scalar-local fix). Wrap-canonicalising patterns
 *     like `(a*b) | 0` still qualify via the top-level bitwise op.
 *   - `>>>` — produces uint32 which can sit above 2^31, reinterpreted as a
 *     negative i32 on store.
 */
export function isI32SafeExprForArray(
  expr: ts.Expression | undefined,
  i32Locals: ReadonlySet<string>,
  oracle?: TypeOracle,
  depth = 0,
): boolean {
  if (!expr) return false;
  if (depth > 32) return false;

  if (oracle && isNonNegativeStaticI32Expression(expr, oracle)) return true;

  if (ts.isParenthesizedExpression(expr)) {
    return isI32SafeExprForArray(expr.expression, i32Locals, oracle, depth + 1);
  }
  if (ts.isAsExpression(expr) || ts.isNonNullExpression(expr)) {
    return isI32SafeExprForArray(expr.expression, i32Locals, oracle, depth + 1);
  }
  if (ts.isTypeAssertionExpression(expr)) {
    return isI32SafeExprForArray(expr.expression, i32Locals, oracle, depth + 1);
  }

  if (ts.isNumericLiteral(expr)) {
    const n = Number(expr.text.replace(/_/g, ""));
    return Number.isInteger(n) && n >= -2147483648 && n <= 2147483647;
  }

  if (ts.isIdentifier(expr)) {
    return i32Locals.has(expr.text);
  }

  if (ts.isPrefixUnaryExpression(expr)) {
    const op = expr.operator;
    // `~x` always yields a canonical int32; unary `+x` is the identity on an
    // i32-safe operand. Both preserve the canonical-i32 invariant.
    if (op === ts.SyntaxKind.PlusToken || op === ts.SyntaxKind.TildeToken) {
      return isI32SafeExprForArray(expr.operand, i32Locals, oracle, depth + 1);
    }
    // #2789: unary `-` can produce negative zero. i32 cannot represent `-0`
    // (it collapses to `+0`), so storing `-0` and then observing the sign of
    // zero on read (`1 / x`, `Object.is(x, -0)`) diverges from the always-correct
    // f64 backing. Admit ONLY `-<non-zero integer literal>` — a constant sentinel
    // like `-1`, whose value is a canonical i32 with no `-0` hazard. This is a
    // strict subset of the prior `isI32SafeExprForArray(operand)` acceptance, so
    // it can only demote (never newly promote). `-x` over an identifier (which
    // could hold 0) and `-(expr)` demote to the f64 array.
    if (op === ts.SyntaxKind.MinusToken) {
      if (!ts.isNumericLiteral(expr.operand)) return false;
      if (!isI32SafeExprForArray(expr.operand, i32Locals, oracle, depth + 1)) return false;
      return Number(expr.operand.text.replace(/_/g, "")) !== 0;
    }
    return false;
  }

  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    // Bitwise / signed shifts always produce int32
    if (
      op === ts.SyntaxKind.BarToken ||
      op === ts.SyntaxKind.AmpersandToken ||
      op === ts.SyntaxKind.CaretToken ||
      op === ts.SyntaxKind.LessThanLessThanToken ||
      op === ts.SyntaxKind.GreaterThanGreaterThanToken
    ) {
      return true;
    }
    // Comparisons → i32 (boolean)
    if (
      op === ts.SyntaxKind.LessThanToken ||
      op === ts.SyntaxKind.LessThanEqualsToken ||
      op === ts.SyntaxKind.GreaterThanToken ||
      op === ts.SyntaxKind.GreaterThanEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken
    ) {
      return true;
    }
    // #2789 (mirrors the #1236 scalar-local fix): `+`, `-`, `*` of two number
    // operands are evaluated as f64 in codegen (JS spec: `number op number` is
    // f64), then stored into the i32 backing via `i32.trunc_sat_f64_s`. That
    // saturates rather than wraps on overflow, so e.g. `arr[i] = a * b` with
    // `a*b = 2.5e9` stores 2147483647 instead of the spec-correct 2500000000 —
    // a MISCOMPILE the f64 backing does not have. We cannot statically bound the
    // operands to prove no overflow, so demote: any `+`/`-`/`*` write keeps the
    // array f64. The common wrap-canonicalising patterns `(a*b) | 0` / `(a+b) &
    // MASK` are unaffected — their TOP-level op is bitwise, which returns true
    // above without recursing, and `| 0` makes the value a canonical int32 that
    // matches both backings.
    if (op === ts.SyntaxKind.PlusToken || op === ts.SyntaxKind.MinusToken || op === ts.SyntaxKind.AsteriskToken) {
      return false;
    }
    return false;
  }

  return false;
}

/** Recognise `T[]` or `Array<T>` where T is the `number` keyword. */
function isNumberArrayTypeNode(node: ts.TypeNode | undefined): boolean {
  if (!node) return false;
  if (ts.isArrayTypeNode(node)) {
    return node.elementType.kind === ts.SyntaxKind.NumberKeyword;
  }
  if (
    ts.isTypeReferenceNode(node) &&
    ts.isIdentifier(node.typeName) &&
    node.typeName.text === "Array" &&
    node.typeArguments?.length === 1
  ) {
    return node.typeArguments[0]!.kind === ts.SyntaxKind.NumberKeyword;
  }
  return false;
}

/**
 * Recognise initializers we know how to lower as a fresh i32 vec:
 *   - `[]` (empty array literal)
 *   - `new Array(...)` / `Array(...)` (constructed with no elements or a length only)
 */
function isQualifyingInit(init: ts.Expression | undefined): boolean {
  if (!init) return false;
  if (ts.isArrayLiteralExpression(init) && init.elements.length === 0) return true;
  if (ts.isNewExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === "Array") {
    return true;
  }
  if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === "Array") {
    return true;
  }
  return false;
}

/** Match the syntactic for-counter pattern that detectI32LoopVar promotes. */
function collectForCounterNames(decl: ts.FunctionLikeDeclaration): Set<string> {
  const out = new Set<string>();
  if (!decl.body) return out;

  function visit(node: ts.Node): void {
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
    if (ts.isForStatement(node) && node.initializer && ts.isVariableDeclarationList(node.initializer)) {
      const isLetConst = (node.initializer.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0;
      if (isLetConst) {
        for (const v of node.initializer.declarations) {
          if (ts.isIdentifier(v.name) && v.initializer && ts.isNumericLiteral(v.initializer)) {
            const n = Number(v.initializer.text.replace(/_/g, ""));
            if (Number.isInteger(n) && n >= -2147483648 && n <= 2147483647) {
              out.add(v.name.text);
            }
          }
        }
      }
    }
    forEachChild(node, visit);
  }
  visit(decl.body);
  return out;
}

/**
 * Compute the set of `let arr: number[] = []`-style locals in `decl` whose
 * element storage can safely lower to `i32` instead of `f64`.
 *
 * Pre-conditions for promotion (all must hold):
 *   1. The declaration has an explicit `number[]` (or `Array<number>`) type
 *      annotation. Without the annotation, downstream codegen still picks
 *      f64 from the contextual type and the override would not flow to the
 *      assignment-site `compileExpression(value, arrDef.element)` path.
 *   2. The initializer is `[]`, `new Array(n?)`, or `Array(n?)`.
 *   3. The local is not captured in any nested function (closures break
 *      cross-scope type assumptions, exactly as for #1120 scalar locals).
 *   4. The local is never used outside whitelisted positions:
 *        - `arr[i]` (read)            (parent: ElementAccessExpression as receiver)
 *        - `arr[i] = E`                (parent of `arr` is the LHS access)
 *        - `arr.length`               (PropertyAccessExpression as receiver)
 *        - `arr.push(E)` / `arr[i]++` / etc. — only `arr.push(E)` is allowed,
 *          and only when E is i32-safe. All other method calls disqualify.
 *   5. Every `arr[i] = E` has E i32-safe per `isI32SafeExprForArray`.
 *   6. The local is never the LHS of a plain assignment (`arr = ...` after
 *      the declaration) — the candidate-collection step already restricts
 *      to let/const, but a single-let `let arr: number[]` could still be
 *      reassigned. We catch this in the use scan because a bare identifier
 *      reference on the LHS of `=` is not in the whitelist.
 */
export function collectI32SpecializedArrays(
  decl: ts.FunctionLikeDeclaration,
  i32CoercedLocals: ReadonlySet<string>,
  oracle?: TypeOracle,
): Set<string> {
  const result = new Set<string>();
  if (!decl.body || !ts.isBlock(decl.body)) return result;

  const forCounters = collectForCounterNames(decl);
  // The combined view of "things that read as i32 in expressions". This drives
  // the i32-shape test for RHS expressions on `arr[i] = E` / `arr.push(E)`.
  const i32Locals = new Set<string>([...i32CoercedLocals, ...forCounters]);

  // Step 1: gather candidates.
  const candidates = new Set<string>();
  const candidateDecls = new Map<string, ts.VariableDeclaration>();

  function collectDecls(node: ts.Node): void {
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
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const list = node.parent;
      if (ts.isVariableDeclarationList(list)) {
        const isLetConst = (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0;
        if (isLetConst && isNumberArrayTypeNode(node.type) && isQualifyingInit(node.initializer)) {
          // Drop on shadowing (same conservative rule as #1120).
          if (candidates.has(node.name.text)) {
            candidates.delete(node.name.text);
            candidateDecls.delete(node.name.text);
          } else {
            candidates.add(node.name.text);
            candidateDecls.set(node.name.text, node);
          }
        }
      }
    }
    forEachChild(node, collectDecls);
  }
  forEachChild(decl.body, collectDecls);

  if (candidates.size === 0) return result;

  // Step 2: scan all uses, disqualifying as we go.
  const disqualified = new Set<string>();

  /** True if `id` is the receiver position of a property/element access OR is
   * the declaration's own name. False otherwise. */
  function isAllowedIdentifierContext(id: ts.Identifier): boolean {
    const parent = id.parent;
    if (!parent) return false;

    // Declaration name itself: `let arr: number[] = ...`
    if (ts.isVariableDeclaration(parent) && parent.name === id) {
      return candidateDecls.get(id.text) === parent;
    }

    // arr[i] / arr.length / arr.push(...) — receiver of access
    if (ts.isPropertyAccessExpression(parent) && parent.expression === id) return true;
    if (ts.isElementAccessExpression(parent) && parent.expression === id) return true;

    return false;
  }

  function visit(node: ts.Node, insideNested: boolean): void {
    // Descend into nested functions but mark candidate references as escapes.
    if (
      node !== decl &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isAccessor(node) ||
        ts.isConstructorDeclaration(node))
    ) {
      forEachChild(node, (c) => visit(c, true));
      return;
    }

    // arr[i] = E — verify E is i32-safe. We still recurse to catch other uses
    // inside E and inside the index expression.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(node.left) &&
      ts.isIdentifier(node.left.expression) &&
      candidates.has(node.left.expression.text) &&
      !insideNested
    ) {
      if (!isI32SafeExprForArray(node.right, i32Locals, oracle)) {
        disqualified.add(node.left.expression.text);
      }
    }

    // Disqualify compound-assignment `arr[i] += E` etc. — the read-modify-write
    // path stores the result back, and if we don't know the read-modify result
    // is i32-safe, the round-trip would mis-coerce. Conservative: disqualify.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind !== ts.SyntaxKind.EqualsToken &&
      isCompoundAssignment(node.operatorToken.kind) &&
      ts.isElementAccessExpression(node.left) &&
      ts.isIdentifier(node.left.expression) &&
      candidates.has(node.left.expression.text)
    ) {
      const arrName = node.left.expression.text;
      // Bitwise compounds (|=, &=, ^=, <<=, >>=) keep the value in a canonical
      // int32 — safe (the result equals its f64 image, so both backings agree).
      // #2789 (mirrors #1236): arithmetic compounds (+=, -=, *=) desugar to
      // `arr[i] = arr[i] + E`, whose f64 arithmetic is stored back through
      // `i32.trunc_sat_f64_s` — saturating on overflow rather than producing the
      // spec-correct f64. e.g. `arr[0] += 2e9` after `arr[0] = 2e9` stores
      // 2147483647 instead of 4000000000. We cannot statically prove no overflow
      // (the live element value is unknown), so demote the whole array to f64.
      // `>>>=` is likewise excluded (uint32 can exceed 2^31). Only the five
      // canonical-int32 bitwise/signed-shift compounds survive.
      const isBitwiseCompound =
        node.operatorToken.kind === ts.SyntaxKind.BarEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.AmpersandEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.CaretEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.LessThanLessThanEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken;
      if (!isBitwiseCompound) {
        disqualified.add(arrName);
      }
    }

    // arr.METHOD(...) — only `.push(...)` with i32-safe args is allowed.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      candidates.has(node.expression.expression.text)
    ) {
      const arrName = node.expression.expression.text;
      const method = node.expression.name.text;
      if (method === "push") {
        for (const arg of node.arguments) {
          if (ts.isSpreadElement(arg) || !isI32SafeExprForArray(arg, i32Locals, oracle)) {
            disqualified.add(arrName);
            break;
          }
        }
      } else if (
        method === "indexOf" &&
        node.arguments.length >= 1 &&
        node.arguments.length <= 2 &&
        !ts.isSpreadElement(node.arguments[0]!) &&
        isI32SafeExprForArray(node.arguments[0]!, i32Locals, oracle)
      ) {
        // Read-only and representation-transparent when the strict-equality
        // search value is itself an exact signed int32. A fractional, `-0`, or
        // out-of-range search value keeps the f64 backing so compiling the
        // argument for an i32 element cannot change the match result.
      } else {
        // .map / .filter / .reduce / .slice / .splice / .includes / etc.
        // would require f64 element semantics or callback type inference. Skip
        // them all conservatively; future work can lift specific cases.
        disqualified.add(arrName);
      }
    }

    // Bare identifier reference: must be in an allowed context.
    if (ts.isIdentifier(node) && candidates.has(node.text)) {
      if (insideNested) {
        disqualified.add(node.text);
      } else if (!isAllowedIdentifierContext(node)) {
        disqualified.add(node.text);
      }
    }

    forEachChild(node, (c) => visit(c, insideNested));
  }

  forEachChild(decl.body, (child) => visit(child, false));

  for (const name of candidates) {
    if (!disqualified.has(name)) result.add(name);
  }
  return result;
}

function isCompoundAssignment(kind: ts.SyntaxKind): boolean {
  switch (kind) {
    case ts.SyntaxKind.PlusEqualsToken:
    case ts.SyntaxKind.MinusEqualsToken:
    case ts.SyntaxKind.AsteriskEqualsToken:
    case ts.SyntaxKind.SlashEqualsToken:
    case ts.SyntaxKind.PercentEqualsToken:
    case ts.SyntaxKind.AsteriskAsteriskEqualsToken:
    case ts.SyntaxKind.BarEqualsToken:
    case ts.SyntaxKind.AmpersandEqualsToken:
    case ts.SyntaxKind.CaretEqualsToken:
    case ts.SyntaxKind.LessThanLessThanEqualsToken:
    case ts.SyntaxKind.GreaterThanGreaterThanEqualsToken:
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken:
      return true;
    default:
      return false;
  }
}
