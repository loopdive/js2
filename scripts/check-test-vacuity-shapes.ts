#!/usr/bin/env npx tsx
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#3613) OUR OWN REGRESSION TESTS CAN PASS VACUOUSLY TOO.
//
// The trap
// --------
// Several codegen paths are gated on the callee being a bare IDENTIFIER —
// e.g. `src/codegen/expressions/new-super.ts` opens with `if
// (!ts.isIdentifier(calleeExpr)) return false;` in three separate places. A
// TypeScript cast around the callee is a **type-level no-op that changes the
// AST**:
//
//     new X(...)            → NewExpression(expression: Identifier)        ✔ gated path
//     new (X as any)(...)   → NewExpression(expression: Parenthesized(As)) ✘ generic path
//
// So a regression test written with `new (X as any)(...)` silently exercises a
// DIFFERENT code path than the fix it is guarding. Measured on this repo
// (standalone lane, `.tmp/probe-castnew2.mts`):
//
//     throw new TypeError("MARKER-77")             → "TypeError: MARKER-77"
//     throw new (TypeError as any)("MARKER-77")    → "[object WebAssembly.Exception]"
//
// The second never mints an `$Error_struct` at all. A test using it can assert
// "something was thrown" and go green while the code under test is untouched —
// the fix LOOKS protected when it is not, so the defect can silently return.
// The `assertion_fail` lane hit exactly this on 2026-07-25: 3 of 6 cases in a
// regression test passed vacuously, caught only because the author manually
// removed the fix and checked the test actually went red.
//
// This is the same family as a vacuous test262 pass — an assertion that runs
// but validates nothing — and arguably worse, because it is invisible: the
// cast looks like a no-op.
//
// The gate
// --------
// This shape is currently ABSENT from the repo (0 hits across 2,617 files at
// the time of writing), so the gate is a clean ratchet at zero rather than a
// baseline to grind down.
//
// The fix is always to move the cast OFF the callee:
//
//     new (X as any)(a, b)        →  new X(a, b) as any
//     new (X as any)(a, b).m()    →  (new X(a, b) as any).m()
//
// Deliberate exceptions (a test that IS exercising the non-identifier callee
// path) opt out with a comment on or above the line:
//
//     // vacuity-shape-allow: this case deliberately probes the generic path
//
// Usage:
//   npx tsx scripts/check-test-vacuity-shapes.ts            # gate
//   npx tsx scripts/check-test-vacuity-shapes.ts --json

import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// `new URL(...).pathname` leaves the path PERCENT-ENCODED, so a checkout under a
// directory with a space (`/Volumes/Archiv Mini/…`) resolved to a non-existent
// `/Volumes/Archiv%20Mini/…` and the glob matched NOTHING — the gate scanned 0
// files and refused, which is exactly how this was found. `fileURLToPath` decodes.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const ALLOW_MARKER = "vacuity-shape-allow";

export interface ShapeFinding {
  file: string;
  line: number;
  text: string;
  callee: string;
}

/**
 * Does this `new` expression wrap its callee in a type-level no-op that
 * changes the AST shape? `as T`, `<T>x`, `x!` and `satisfies T` all do.
 *
 * Note it must be the CALLEE that is wrapped: `new X(y as any)` is fine (the
 * cast is on an argument), and `new (getCtor())(...)` is a genuine computed
 * callee, not an accidental one — only type-level wrappers are flagged,
 * because only those LOOK like no-ops.
 */
export function isVacuityInducingNewCallee(node: ts.NewExpression): boolean {
  if (!ts.isParenthesizedExpression(node.expression)) return false;
  const inner = node.expression.expression;
  return (
    ts.isAsExpression(inner) ||
    ts.isTypeAssertionExpression(inner) ||
    ts.isNonNullExpression(inner) ||
    ts.isSatisfiesExpression(inner)
  );
}

/** Pure scanner — drives the unit tests with in-memory sources. */
export function findVacuityShapes(fileName: string, source: string): ShapeFinding[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = source.split("\n");
  const findings: ShapeFinding[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && isVacuityInducingNewCallee(node)) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
      // Opt-out on the same line or the line above.
      const own = lines[line] ?? "";
      const prev = line > 0 ? (lines[line - 1] ?? "") : "";
      if (!own.includes(ALLOW_MARKER) && !prev.includes(ALLOW_MARKER)) {
        const inner = (node.expression as ts.ParenthesizedExpression).expression;
        const callee = ts.isNonNullExpression(inner)
          ? inner.expression.getText()
          : (inner as ts.AsExpression).expression.getText();
        findings.push({
          file: fileName,
          line: line + 1,
          text: node.getText().split("\n")[0]!.slice(0, 100),
          callee,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

export function scanRepoTests(root = REPO_ROOT): { findings: ShapeFinding[]; scanned: number } {
  const files = globSync("tests/**/*.ts", { cwd: root });
  const findings: ShapeFinding[] = [];
  for (const rel of files) {
    const abs = resolve(root, rel);
    findings.push(...findVacuityShapes(relative(root, abs), readFileSync(abs, "utf-8")));
  }
  return { findings, scanned: files.length };
}

function main() {
  const { findings, scanned } = scanRepoTests();
  // POSITIVE CONTROL on the scanner itself: if it scanned nothing, a zero
  // finding count is a broken glob, not a clean tree (#3613).
  if (scanned === 0) {
    console.error(
      "check-test-vacuity-shapes: scanned 0 files — refusing to report a clean result from a scanner that " +
        "looked at nothing (#3613 vacuous-verifier rule). Check the glob / working directory.",
    );
    process.exit(2);
  }
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ scanned, findings }, null, 2));
  }
  if (findings.length === 0) {
    console.log(
      `check-test-vacuity-shapes: OK — 0 identifier-gate-defeating \`new\` callees in ${scanned} test files.`,
    );
    process.exit(0);
  }
  console.error(
    `check-test-vacuity-shapes: ${findings.length} test(s) wrap a \`new\` callee in a type-level cast, which ` +
      `changes the AST shape and routes past identifier-gated codegen (#3613).\n` +
      `A regression test written this way exercises a DIFFERENT path than the fix it guards — it looks ` +
      `protected when it is not.\n`,
  );
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  ${f.text}`);
    console.error(`      → write \`new ${f.callee}(...) as T\` instead (cast the RESULT, not the callee).`);
  }
  console.error(`\nDeliberate exception? Add \`// ${ALLOW_MARKER}: <why>\` on or above the line.`);
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]).endsWith("check-test-vacuity-shapes.ts")) {
  main();
}
