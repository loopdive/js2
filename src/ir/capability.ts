// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2135 — the IR capability table: ONE source of truth for "what can the IR
// front-end lower", consumed by BOTH sides of the claim boundary:
//
//   - the selector (`select.ts` — `isPhase1BinaryOp` / `isPhase1PrefixOp`)
//     decides whether a function containing the construct may be CLAIMED;
//   - the builder (`from-ast.ts` — `lowerBinary` / `lowerPrefixUnary`)
//     asserts on entry that a capability-deferred construct can never reach
//     it post-claim.
//
// Why this file exists (#2135): "what IR can do" used to be encoded twice —
// the selector accepted shapes the builder threw on *by design* ("shape-only
// acceptance ... lowering throws cleanly so the function falls back to
// legacy"). That deliberate over-claim leaned on the demote-to-warning
// fallback channel, which #2855 phases out and which the #2138 IR-first
// inversion turns into a HARD compile error on a skipped slot (a placeholder
// body would otherwise ship — see `[IR-FIRST skipped-slot, #2138]`). With the
// table, a selector claim is by-construction backed by a builder lowering:
// disagreement is impossible for table-covered constructs, and adding an IR
// feature means flipping ONE row here (plus the lowering), never editing two
// predicates. #2945 (the `%` drift #2138's flag surfaced) is the founding
// example.
//
// ── The three capability states ────────────────────────────────────────────
//
// "claim"          The selector accepts the construct AND the builder lowers
//                  it for every operand the *shape* rules admit. The builder
//                  may still fail on operand TYPES it cannot represent
//                  (e.g. an operand that lowers to a string in an f64 slot) —
//                  those are type-level demotes owned by the type-resolution
//                  lane, not capability drift.
//
// "claim-partial"  TRANSITIONAL. The selector accepts, and the builder lowers
//                  a documented SUBSET, throwing a clean fallback otherwise.
//                  Every entry MUST carry the tracking issue that either
//                  completes the lowering (→ "claim") or narrows the selector
//                  (→ "defer"). Under #2138's IR-first flag these residual
//                  throws remain the honest post-claim-demote metric
//                  (`irPostClaimErrors`) that #1923 meters.
//
// "defer"          The selector REJECTS the construct (routes the function to
//                  legacy up-front, bucketed by the selector's telemetry).
//                  The builder can therefore never see it post-claim; its
//                  guard for a deferred construct is an internal-invariant
//                  assertion, not a fallback path.
//
// Anything NOT in a table defaults to "defer" — new syntax is legacy-only
// until a row (plus a lowering) claims it.

import { ts, forEachChild } from "../ts-api.js";

export type IrOpCapability = "claim" | "claim-partial" | "defer";

// ── Binary operators (`lowerBinary` family) ────────────────────────────────
//
// History of the rows:
//   - the "claim" set mirrors slice 11 (#1169n): arithmetic, comparisons,
//     logical short-circuit (#1820), and ToInt32-wrapped bitwise ops;
//   - `+` is claim-partial: #2781's Row-7 proof gate demands both operands
//     provably number or provably string (checker present); unprovable
//     operand pairs demote to legacy's dynamic `+`;
//   - `??` is claim-partial: `lowerNullish` handles a reference-shaped lhs
//     with same-typed arms; other operand types demote (#1131);
//   - `%`, `**`, `in`, `instanceof` were claimed shape-only with NO lowering
//     ("slice 11 shape-only acceptance") — the exact selector↔builder drift
//     #2135 retires. They are now DEFERRED: the selector rejects them
//     up-front. Implementing a lowering (e.g. #2945 for `%`) flips the row
//     to "claim" in the same PR as the lowering.
const BINARY_OP_CAPABILITY: ReadonlyMap<ts.SyntaxKind, IrOpCapability> = new Map<ts.SyntaxKind, IrOpCapability>([
  // Numeric arithmetic (f64; i32 via propagation rules).
  [ts.SyntaxKind.MinusToken, "claim"],
  [ts.SyntaxKind.AsteriskToken, "claim"],
  [ts.SyntaxKind.SlashToken, "claim"],
  // `+` — string-concat-or-numeric-add chosen at runtime in JS; the IR
  // specializes only under #2781's operand-type proof (both-number or
  // both-string). Unprovable pairs (any / unions / mixed) demote. → "claim"
  // once the dynamic-`+` lowering lands in IR (tracked via #2781/#1131).
  [ts.SyntaxKind.PlusToken, "claim-partial"],
  // Comparisons (f64/i32/string per operand resolution).
  [ts.SyntaxKind.LessThanToken, "claim"],
  [ts.SyntaxKind.LessThanEqualsToken, "claim"],
  [ts.SyntaxKind.GreaterThanToken, "claim"],
  [ts.SyntaxKind.GreaterThanEqualsToken, "claim"],
  [ts.SyntaxKind.EqualsEqualsEqualsToken, "claim"],
  [ts.SyntaxKind.EqualsEqualsToken, "claim"],
  [ts.SyntaxKind.ExclamationEqualsEqualsToken, "claim"],
  [ts.SyntaxKind.ExclamationEqualsToken, "claim"],
  // Logical short-circuit (#1820 — IrInstrIf lowering, right arm lazy).
  [ts.SyntaxKind.AmpersandAmpersandToken, "claim"],
  [ts.SyntaxKind.BarBarToken, "claim"],
  // `??` — lowered over a reference-shaped lhs with same-typed arms
  // (`lowerNullish`); non-reference / mismatched operand types demote (#1131).
  [ts.SyntaxKind.QuestionQuestionToken, "claim-partial"],
  // Bitwise (slice 11 — JS ToInt32 each operand, i32 op, convert back).
  [ts.SyntaxKind.AmpersandToken, "claim"],
  [ts.SyntaxKind.BarToken, "claim"],
  [ts.SyntaxKind.CaretToken, "claim"],
  [ts.SyntaxKind.LessThanLessThanToken, "claim"],
  [ts.SyntaxKind.GreaterThanGreaterThanToken, "claim"],
  [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken, "claim"],
  // `%` — lowered as a call to the Wasm-native exact-remainder helper
  // (`__fmod`, #2056) — the SAME helper legacy's `emitModulo` calls, so IR
  // and legacy agree bit-for-bit (incl. `x % 0` → NaN, `-0 % x` → -0,
  // `Inf % x` → NaN, `x % Inf` → x, and large-quotient exactness where the
  // naive `a - trunc(a/b)*b` formula collapses or overflows). f64 operands
  // only; i32-typed / string operands demote via the type-resolution lane
  // (legacy's i32 fast mode keeps `emitSafeI32Rem`). Claimed via #2945.
  [ts.SyntaxKind.PercentToken, "claim"],
  // Deferred — no IR lowering exists. Selector rejects; builder asserts.
  [ts.SyntaxKind.AsteriskAsteriskToken, "defer"], // needs Math.pow-equivalent lowering
  [ts.SyntaxKind.InKeyword, "defer"], // needs property/prototype-chain probe
  [ts.SyntaxKind.InstanceOfKeyword, "defer"], // needs class-shape / brand check
]);

// ── Prefix unary operators (`lowerPrefixUnary` family) ─────────────────────
//
// `++` / `--` in statement position are handled by the assignment lane, not
// `lowerPrefixUnary`; the rows here cover VALUE-position prefix expressions,
// matching `isPhase1PrefixOp`'s historical accept set exactly.
const PREFIX_OP_CAPABILITY: ReadonlyMap<ts.PrefixUnaryOperator, IrOpCapability> = new Map<
  ts.PrefixUnaryOperator,
  IrOpCapability
>([
  [ts.SyntaxKind.MinusToken, "claim"], // f64.neg
  [ts.SyntaxKind.PlusToken, "claim"], // numeric identity
  [ts.SyntaxKind.ExclamationToken, "claim"], // i32.eqz over bool
  // `~x` is the same ToInt32 composite as `x ^ -1`. The selector only
  // admits operands proven numeric; wider JS coercions remain legacy-owned.
  [ts.SyntaxKind.TildeToken, "claim-partial"],
]);

// ── Host-extern member access (#2856 — document/console et al.) ────────────
//
// Host ambient globals (`document`, `window`, …) and their member
// reads/writes/calls lower through the legacy extern-class per-member import
// surface (`global_<name>`, `<Class>_get_<prop>`, `<Class>_<method>`,
// `console_<method>_<variant>`), which only a JS host can satisfy. The
// capability is therefore MODE-GATED:
//
//   - JS-host mode → "claim-partial": the selector accepts host-global
//     identifiers and member shapes on them; from-ast lowers the subset whose
//     members resolve in the extern registry (chain walk). Residuals (an
//     unregistered member, an unbranded chained receiver) demote via the
//     metered irPostClaimErrors channel. Tracking issue: #2856.
//   - standalone / wasi / strictNoHostImports → "defer": there is no host;
//     the selector rejects up-front and the function stays on the legacy
//     path, which routes `document.*` to the existing #1472/#2907 refusal.
//     from-ast guards with `assertNotDeferred` — a host-extern node arriving
//     post-claim in a host-free mode is a capability violation, not a
//     fallback.
export function hostExternCapability(jsHost: boolean): IrOpCapability {
  return jsHost ? "claim-partial" : "defer";
}

// ── Exact standalone DOM provider (#4576) ─────────────────────────────────
//
// A standalone embedder can explicitly supply one authenticated DOM subtree
// without making the target a general JavaScript host. Keep that authority
// separate from `hostExternCapability`: setting `jsHostExterns` would also
// admit arbitrary ambient globals and every extern-class member. The checker-
// backed `IrStandaloneDomCapabilityPlan` instead proves one closed member/use
// set, for which selection and lowering share node identity.
export function domSurfaceCapability(jsHost: boolean, exactStandaloneProvider: boolean): IrOpCapability {
  if (jsHost) return "claim-partial";
  return exactStandaloneProvider ? "claim" : "defer";
}

// ── The console sub-surface (#4462) ────────────────────────────────────────
//
// `hostExternCapability` above is a flat `jsHost ? claim-partial : defer`
// because, when it was written, EVERY member of the ambient host surface was
// import-serviced. That is no longer true: `console` has a host-free lowering
// in standalone (the #3469 `__stdout_append` sink that legacy already uses),
// while `document` does not — legacy's own standalone body for a DOM unit still
// leaks `env.Document_createElement` past the #2961 import-leak gate. One
// boolean can no longer speak for the whole surface, so the console member gets
// its own row.
//
// The second parameter is NOT a mode flag — it is "did the backend actually
// mint the sink", answered by the resolver from `funcMap`. That keeps the
// question a *capability* one (is there something to lower to?) rather than a
// target-name one, so a standalone module compiled without native strings, where
// the sink genuinely does not exist, correctly defers.
export function consoleSurfaceCapability(jsHost: boolean, hostFreeSink: boolean): IrOpCapability {
  if (jsHost) return "claim-partial"; // per-arg-variant `console_<m>_<variant>` imports
  return hostFreeSink ? "claim-partial" : "defer";
}

/** Capability of a BinaryExpression operator token. Unknown ops → "defer". */
export function binaryOpCapability(op: ts.SyntaxKind): IrOpCapability {
  return BINARY_OP_CAPABILITY.get(op) ?? "defer";
}

/** Capability of a value-position PrefixUnaryExpression operator. Unknown ops → "defer". */
export function prefixOpCapability(op: ts.PrefixUnaryOperator): IrOpCapability {
  return PREFIX_OP_CAPABILITY.get(op) ?? "defer";
}

/**
 * Builder-side invariant guard. Call on entry to a lowering dispatch with the
 * construct's capability: a "defer" construct arriving post-claim means the
 * selector and this table disagreed — a claim-path bug, NOT a legitimate
 * legacy fallback. The thrown message is deliberately distinct from the
 * `not in slice N` fallback family so the #1923 post-claim meter and the
 * #2138 IR-first hard-error channel surface it as a capability violation.
 */
export function assertNotDeferred(cap: IrOpCapability, what: string, funcName: string): void {
  if (cap === "defer") {
    throw new Error(
      `ir/from-ast: internal capability violation — ${what} is capability-deferred (see src/ir/capability.ts) yet reached the builder post-claim in ${funcName}. The selector and the capability table disagree; this is a compiler bug, not a fallback.`,
    );
  }
}

// ── Element access (`lowerElementAccess` family) — claim-partial ───────────
//
// (#2972) The element-access family is CLAIM-PARTIAL by nature: the
// selector's shape gate is receiver+index Phase-1-ness (it cannot see
// receiver TYPES), while the builder dispatches by the lowered receiver's
// IrType. Lowered arms today: string-literal key on an object shape; any
// index on a vec receiver (#2766 prove-then-specialize bounds handling);
// PROVEN-in-bounds computed index on a string receiver (predicate below).
// The residual (unproven string index, other receiver types) demotes through
// the metered post-claim channel — under #2138's IR-first flag a skipped
// slot turns that residual into a hard error, which is what surfaced the
// 14-test #2972 class. Retiring the residual = either widening the proof or
// a string|undefined result representation (rejected for now — see
// plan/issues/2972-*.md).
//
// The proof predicate lives HERE (not in from-ast) so a future selector
// tightening or an IR-first skip gate consults the SAME guard — one
// predicate, never two.

/** (#2972) `e` as a non-negative integer NumericLiteral, else null. */
function nonNegIntLiteral(e: ts.Expression): number | null {
  if (!ts.isNumericLiteral(e)) return null;
  const v = Number(e.text);
  return Number.isInteger(v) && v >= 0 ? v : null;
}

/**
 * (#2972) Conservative in-bounds proof for a string element read: is the
 * index expression STATICALLY guaranteed to be an integer in [0, len)?
 * Accepted shapes:
 *   - a non-negative integer literal `< len`;
 *   - `<expr> & K` / `K & <expr>` with a non-negative int32 literal K < len
 *     (bitwise ops ToInt32 both operands; AND with a non-negative mask
 *     yields an integer in [0, K] — the test262 harness shape
 *     `hex[(n >> 4) & 0xf]` on a 16-char literal).
 * Everything else → false (the caller demotes to legacy — sound default:
 * an UNPROVEN index could be out of bounds, where JS `s[i]` is `undefined`
 * but charAt is `""`, so typing the result `string` would be unsound).
 */
export function stringIndexProvenBelow(argExpr: ts.Expression, len: number): boolean {
  let e: ts.Expression = argExpr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  const lit = nonNegIntLiteral(e);
  if (lit !== null) return lit < len;
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandToken) {
    let l: ts.Expression = e.left;
    let r: ts.Expression = e.right;
    while (ts.isParenthesizedExpression(l)) l = l.expression;
    while (ts.isParenthesizedExpression(r)) r = r.expression;
    const k = nonNegIntLiteral(l) ?? nonNegIntLiteral(r);
    if (k !== null && k <= 0x7fffffff) return k < len;
  }
  return false;
}

/**
 * (#2972) Names bound EXACTLY ONCE to a string-literal initializer and never
 * written anywhere in the function — including inside nested function bodies
 * (a closure-captured write would invalidate the literal-length fact just the
 * same, so this is deliberately stricter than from-ast's `mutatedLets`, which
 * skips nested bodies). Value = the literal's UTF-16 code-unit length.
 *
 * TWO consumers, one source (#2972's acceptance criterion):
 *   - from-ast's `lowerElementAccess` — a receiver in this map has a
 *     statically known `.length`, enabling the proven-in-bounds charAt read;
 *   - the IR-first skip gate (`irFirstBodyReadsStringElement`, gate 5) — a
 *     proven read is LOWERABLE and must not exclude its function from the
 *     compile-once skip set.
 *
 * Order-independence is safe for the from-ast consumer: a
 * use-before-declaration identifier is not in the selector's scope set, so
 * such functions are never claimed.
 */
export function collectStringLiteralLens(
  fn:
    | ts.FunctionDeclaration
    | ts.MethodDeclaration
    | ts.ConstructorDeclaration
    // #3000-B: accessors reach this via `lowerFunctionAstToIr`; only `.body` is read.
    | ts.GetAccessorDeclaration
    | ts.SetAccessorDeclaration,
): ReadonlyMap<string, number> {
  const lens = new Map<string, number>();
  const declared = new Set<string>();
  const disqualified = new Set<string>();
  if (!fn.body) return lens;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const name = node.name.text;
      if (declared.has(name)) {
        disqualified.add(name); // re-declaration (var shadowing) — drop the fact
      } else {
        declared.add(name);
        if (
          node.initializer &&
          (ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer))
        ) {
          lens.set(name, node.initializer.text.length);
        }
      }
    }
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (
        op === ts.SyntaxKind.EqualsToken ||
        (op >= ts.SyntaxKind.PlusEqualsToken && op <= ts.SyntaxKind.CaretEqualsToken)
      ) {
        if (ts.isIdentifier(node.left)) disqualified.add(node.left.text);
      }
    }
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      const op = node.operator;
      if (op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken) {
        if (ts.isIdentifier(node.operand)) disqualified.add(node.operand.text);
      }
    }
    forEachChild(node, visit); // deliberately DOES descend into nested functions
  };
  forEachChild(fn.body, visit);
  for (const name of disqualified) lens.delete(name);
  return lens;
}

/**
 * (#2972) Is this string element read LOWERABLE by the IR's
 * proven-in-bounds charAt arm? True iff the receiver is an identifier with a
 * literal-known length in `lens` AND the index proof holds. The from-ast arm
 * and gate 5 both route through this — one predicate, two consumers.
 */
export function stringElementReadLowerable(
  expr: ts.ElementAccessExpression,
  lens: ReadonlyMap<string, number>,
): boolean {
  if (expr.questionDotToken) return false;
  if (!ts.isIdentifier(expr.expression)) return false;
  const len = lens.get(expr.expression.text);
  if (len === undefined) return false;
  return stringIndexProvenBelow(expr.argumentExpression, len);
}
