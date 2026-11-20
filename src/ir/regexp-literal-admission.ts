// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7364) The one rule for which static RegExp constructions a lane builds, asked by the selector before it claims
 * and by from-ast where it builds (the only gate on a producer without a selector, the Prepared path). A lane builds
 * a construction through the host constructor, or (#7106 lever R) through its in-module engine when the pattern
 * compiles there and the construction's consumer is one the IR lowers. Every question has an explicit answer: a lane
 * that does not answer a capability builds nothing with it.
 */
import { ts } from "../ts-api.js";
import type { IrBackendTargetCapability } from "./backend/legality.js";
import { matchRegExpCarrierCall, staticRegExpPair } from "../shared/regexp-static.js";
import { outermostParenthesized } from "../shared/binding-writes.js";

/** What a lane builds a static RegExp with: its in-module engine, or the host constructor. */
export type RegExpBuildCapability = Extract<IrBackendTargetCapability, "native-regexp" | "host-regexp-constructor">;

/** The lane's answers; an unanswered question (absent, or not `true`) builds nothing. */
export interface RegExpBuildAnswers {
  supportsBackendCapability?(capability: RegExpBuildCapability): boolean;
  /** Whether the in-module engine compiles the pair (`standaloneStaticRegExpCompiles`). */
  nativeRegExpCompiles?(pattern: string, flags: string): boolean;
  isLibOnlyBinding?(node: ts.Identifier): boolean;
}

/**
 * A static construction the in-module engine builds where the IR consumes it: the receiver of `.test(…)` /
 * `.exec(…)` (R1/R2), a discarded statement (which still throws an invalid pair's SyntaxError), or (R3) an operand
 * of `+`. A property read (`/a/.source`) or a binding has no lowering for it yet.
 */
export function nativeStaticRegExpBuilt(expr: ts.Expression, lane: RegExpBuildAnswers | undefined): boolean {
  const pair = staticRegExpPair(expr, (node) => lane?.isLibOnlyBinding?.(node) === true);
  if (
    pair === undefined ||
    lane?.supportsBackendCapability?.("native-regexp") !== true ||
    lane.nativeRegExpCompiles?.(pair.pattern, pair.flags) !== true
  )
    return false;
  const consumer = outermostParenthesized(expr).parent;
  const methodReceiver =
    ts.isPropertyAccessExpression(consumer) &&
    ts.isCallExpression(consumer.parent) &&
    consumer.parent.expression === consumer &&
    matchRegExpCarrierCall(consumer.parent) !== undefined;
  const additionOperand = ts.isBinaryExpression(consumer) && consumer.operatorToken.kind === ts.SyntaxKind.PlusToken;
  return methodReceiver || additionOperand || ts.isExpressionStatement(consumer);
}

/** Whether the lane builds through the host constructor. */
export function hostRegExpBuilt(lane: RegExpBuildAnswers | undefined): boolean {
  return lane?.supportsBackendCapability?.("host-regexp-constructor") === true;
}

/** A `/pattern/flags` literal the lane builds: through the host constructor, or its in-module engine. */
export function regExpLiteralBuilt(expr: ts.Expression, lane: RegExpBuildAnswers | undefined): boolean {
  return hostRegExpBuilt(lane) || nativeStaticRegExpBuilt(expr, lane);
}
