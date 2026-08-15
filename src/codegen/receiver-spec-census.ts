// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4405 Phase 0) Receiver-specialisation census — instrumentation only, OFF
 * unless `JS2WASM_RECEIVER_SPEC_STATS=1`.
 *
 * ## Why this exists
 *
 * #3683/#3685 shipped the `this`-receiver half of receiver specialisation and it
 * is DEFAULT-ON: inside a typed twin, `this.<field>` resolves to a direct
 * struct op ~97.9 % of the time. The residual gap is on a different axis —
 * receivers that are NOT `this` (`node.start`, `state.pos`, `prop.key`) — and
 * that axis had no instrument. `proven-receiver-stats.ts` measures the tail of
 * it (`asked → proven → inlined`, once a site reaches
 * `tryEmitProvenReceiverFieldGet`), but the FUNNEL ABOVE it was invisible:
 * `resolveTypedThisField` has three silent early returns and
 * `resolveTypedThisWritableField` two, and between them they swallow every
 * attempt that never becomes a proven-receiver question at all.
 *
 * Without those buckets, "the non-`this` axis is worth N accesses" is an
 * estimate. With them it is a measurement, and the three later phases of #4405
 * (proof coverage, struct shape, the write side) are judged against it.
 *
 * ## House rules (identical to `alloc-census.ts` / `proven-receiver-stats.ts`)
 *
 *  - ONE env var, module-local counters, a dump on `process.exit`.
 *  - **Every `note*` call is a STATEMENT, never part of a condition.** That is
 *    what makes "byte-identical when off" true *by construction* rather than by
 *    testing: no control flow anywhere in the compiler can depend on whether the
 *    census is enabled.
 *  - Anything more expensive than a counter bump (`getText()`, a struct-field
 *    lookup) happens inside {@link receiverSpecCensusEnabled}, so a shipping
 *    compile does no extra work at all.
 */
import ts from "typescript";

import { explainReceiverDecline, type ReceiverFlowResult } from "./receiver-flow-analysis.js";

/** Tallies. All empty unless `JS2WASM_RECEIVER_SPEC_STATS=1`. */
export const receiverSpecCensus = {
  /** Named buckets for the previously-silent declines. */
  buckets: new Map<string, number>(),
  /** Receiver-expression SHAPE histogram for the `receiver-not-this` bucket. */
  shapes: new Map<string, number>(),
  /**
   * (Phase 1 diagnosis) For a non-`this` receiver the flow analysis could not
   * prove: `<receiver text> → <which pass dropped it>`. This is the instrument
   * that answers "is it `resolveLocalBinding`, or pass 1d's CallExpression
   * requirement, or a demotion?" without guessing.
   */
  unproven: new Map<string, number>(),
};

export function receiverSpecCensusEnabled(): boolean {
  return process.env.JS2WASM_RECEIVER_SPEC_STATS === "1";
}

let hookInstalled = false;
function installDumpHook(): void {
  if (hookInstalled) return;
  hookInstalled = true;
  process.on("exit", () => {
    const dump = (label: string, m: Map<string, number>, limit: number): string => {
      const rows = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
      const total = [...m.values()].reduce((a, b) => a + b, 0);
      return (
        `[receiver-spec] ${label} total=${total}\n` +
        rows.map(([k, v]) => `[receiver-spec]   ${label}:${k}=${v}\n`).join("")
      );
    };
    process.stderr.write(
      dump("bucket", receiverSpecCensus.buckets, 40) +
        dump("shape", receiverSpecCensus.shapes, 40) +
        dump("unproven", receiverSpecCensus.unproven, 40),
    );
  });
}

/** Bump a named decline bucket. No-op unless the env var is set. */
export function noteReceiverSpec(bucket: string): void {
  if (!receiverSpecCensusEnabled()) return;
  installDumpHook();
  receiverSpecCensus.buckets.set(bucket, (receiverSpecCensus.buckets.get(bucket) ?? 0) + 1);
}

/** Bump the receiver-shape histogram. No-op unless the env var is set. */
export function noteReceiverShape(shape: string): void {
  if (!receiverSpecCensusEnabled()) return;
  installDumpHook();
  receiverSpecCensus.shapes.set(shape, (receiverSpecCensus.shapes.get(shape) ?? 0) + 1);
}

/** Bump the "proof was asked for and refused, because…" histogram. */
export function noteReceiverUnproven(detail: string): void {
  if (!receiverSpecCensusEnabled()) return;
  installDumpHook();
  receiverSpecCensus.unproven.set(detail, (receiverSpecCensus.unproven.get(detail) ?? 0) + 1);
}

/**
 * A stable, low-cardinality description of a receiver expression, matching the
 * vocabulary the #4405 spec's §1.6 table uses: a bare identifier reports its own
 * text (so `node` / `state` / `types$1` are individually visible and rankable),
 * `this.<f>.<>` keeps the intermediate field name, and everything else collapses
 * to its syntactic class.
 *
 * Only ever called from inside a {@link receiverSpecCensusEnabled} guard —
 * `getText()` re-reads source text and is far too expensive for a hot path.
 */
export function receiverShapeOf(receiver: ts.Expression): string {
  if (ts.isIdentifier(receiver)) return receiver.text;
  if (ts.isPropertyAccessExpression(receiver)) {
    const inner = receiver.expression;
    if (inner.kind === ts.SyntaxKind.ThisKeyword) return `this.${receiver.name.text}.<>`;
    return "propaccess";
  }
  if (ts.isElementAccessExpression(receiver)) return "elemaccess";
  if (ts.isCallExpression(receiver)) return "call";
  if (receiver.kind === ts.SyntaxKind.ThisKeyword) return "this";
  if (ts.isParenthesizedExpression(receiver)) return "paren";
  return ts.SyntaxKind[receiver.kind] ?? "unknown";
}

/**
 * Record a non-`this` receiver seen inside a twin: the named bucket plus its
 * shape. One call so the emitter carries one statement, not three.
 */
export function noteReceiverNotThis(receiver: ts.Expression): void {
  if (!receiverSpecCensusEnabled()) return;
  noteReceiverSpec("receiver-not-this");
  noteReceiverShape(receiverShapeOf(receiver));
}

/**
 * Record that the flow analysis refused an IDENTIFIER receiver, attributed to
 * the pass that refused it. Two keys into one histogram: the bare reason
 * aggregates, the named one ranks (`name:node:no-verdict:var-noinit`).
 */
export function noteReceiverDeclineDetail(result: ReceiverFlowResult, receiver: ts.Identifier): void {
  if (!receiverSpecCensusEnabled()) return;
  const why = explainReceiverDecline(result, receiver);
  noteReceiverUnproven(`reason:${why}`);
  noteReceiverUnproven(`name:${receiver.text}:${why}`);
}

/**
 * Record that a receiver never reached the analysis at all because it is not a
 * bare identifier — these must stay separable from identifiers the analysis
 * looked at and refused, or "3,820 unproven" reads as one population when it is
 * two with different fixes.
 */
export function noteReceiverNotIdentifier(receiver: ts.Expression): void {
  if (!receiverSpecCensusEnabled()) return;
  noteReceiverUnproven(`shape:${receiverShapeOf(receiver)}`);
}
