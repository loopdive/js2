// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/** AST-dependent string-encoding inference; kept out of replay-time analysis. */
import { ts } from "../../ts-api.js";
import { classifyLiteral, joinEncoding, type Encoding } from "./encoding.js";

type OperandEvidence = (expr: ts.Expression) => readonly [Encoding | undefined, string];

/** Infer encoding for string-producing syntax that needs checker evidence. */
export function inferEncoding(expr: ts.Expression, evidence: OperandEvidence): Encoding | undefined {
  if (ts.isTemplateExpression(expr)) {
    let encoding = classifyLiteral(expr.head.text);
    for (const span of expr.templateSpans) {
      const [nested, family] = evidence(span.expression);
      const substitution = nested ?? (family === "number" || family === "boolean" ? "ascii" : undefined);
      if (substitution === undefined) return undefined;
      encoding = joinEncoding(encoding, substitution);
      encoding = joinEncoding(encoding, classifyLiteral(span.literal.text));
    }
    return encoding;
  }
  if (
    ts.isCallExpression(expr) &&
    expr.arguments.length === 0 &&
    ts.isPropertyAccessExpression(expr.expression) &&
    expr.expression.name.text === "toString" &&
    evidence(expr.expression.expression)[1] === "number"
  ) {
    // Number::toString emits only the ASCII grammar in host and native lanes.
    return "ascii";
  }
  return undefined;
}
