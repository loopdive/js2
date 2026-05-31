// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1722 — Static Semantics: AssignmentTargetType early SyntaxError.
 *
 * A parenthesized ObjectLiteral / ArrayLiteral is NOT a valid assignment
 * target — `({}) = 1`, `({a:1}) = 1`, and the arrow-body forms
 * `() => ({}) = 1` / `async () => ({}) = 1` are early SyntaxErrors per
 * §13.15.1 (a CoverParenthesizedExpression cannot be refined to an
 * AssignmentPattern). Previously these compiled + instantiated.
 *
 * The valid destructuring AssignmentPattern target appears *directly* as the
 * LHS (`[a,b] = x`, `({a} = x)`), so those must still be accepted. Parentheses
 * remain transparent for simple targets (`(x) = 1`).
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";

async function rejects(src: string): Promise<boolean> {
  const r = await compile(src, { fileName: "test.ts" });
  return r.success === false;
}

describe("#1722 — AssignmentTargetType early SyntaxError", () => {
  it.each(["() => ({}) = 1;", "async () => ({}) = 1;", "({}) = 1;", "({a:1}) = 1;", "() => (1 = 1);"])(
    "rejects invalid assignment target: %j",
    async (src) => {
      expect(await rejects(src)).toBe(true);
    },
  );

  it.each([
    "let x = 0; x = 1;",
    "let x = 0; (x) = 1;",
    "let a = 0, b = 0; [a, b] = [1, 2];",
    "let a = 0; ({ a } = { a: 1 });",
    "let y = 0; const f = () => (y = 1); f();",
  ])("still accepts valid assignment target: %j", async (src) => {
    expect(await rejects(src)).toBe(false);
  });
});
