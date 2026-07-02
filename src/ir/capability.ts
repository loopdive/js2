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

import { ts } from "../ts-api.js";

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
  [ts.SyntaxKind.TildeToken, "defer"], // ToInt32 + i32.xor -1 — not lowered yet
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
