// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2955 — the IR front-end must not read the raw `nativeStrings` mode
// discriminator. Mode decisions belong at lower/integration time (resolver
// capability queries, `resolveFunc` sentinels), so identical source builds
// mode-agnostic IR at the sites the discriminator used to gate. This gate
// enforces the acceptance criterion "from-ast.ts contains zero nativeStrings
// reads (grep-gated)": a functional read regressing into from-ast.ts fails
// here instead of silently re-breeding per-mode IR construction.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const FROM_AST_PATH = join(dirname(fileURLToPath(import.meta.url)), "../src/ir/from-ast.ts");

/** Strip /* *​/ block comments and // line comments, preserving string
 *  literals' content only enough for this gate: the token we hunt cannot
 *  legitimately appear in executable from-ast code at all, and the one
 *  benign non-comment mention today is inside a thrown message string —
 *  so strings are stripped too, keeping the gate future-proof against
 *  wording churn in diagnostics. */
function stripCommentsAndStrings(source: string): string {
  return (
    source
      // block comments (non-greedy, dotall via [\s\S])
      .replace(/\/\*[\s\S]*?\*\//g, "")
      // line comments
      .replace(/\/\/[^\n]*/g, "")
      // template literals (non-greedy; nested ${} with strings is beyond this
      // gate's needs — a false negative there still leaves the plain-call
      // patterns below covered)
      .replace(/`(?:\\.|[^`\\])*`/g, "``")
      // string literals
      .replace(/"(?:\\.|[^"\\])*"/g, '""')
      .replace(/'(?:\\.|[^'\\])*'/g, "''")
  );
}

describe("#2955 — IR front-end string-mode de-polymorphization gate", () => {
  it("src/ir/from-ast.ts has zero functional nativeStrings reads", () => {
    const raw = readFileSync(FROM_AST_PATH, "utf8");
    const code = stripCommentsAndStrings(raw);
    const offenders = code
      .split("\n")
      .map((line, i) => ({ line: line.trim(), lineNo: i + 1 }))
      .filter(({ line }) => line.includes("nativeStrings"));
    expect(
      offenders,
      `from-ast.ts must not read the nativeStrings mode discriminator; ` +
        `route the decision through a lower/integration-time capability instead ` +
        `(offending lines: ${offenders.map((o) => o.lineNo).join(", ")})`,
    ).toEqual([]);
  });
});
