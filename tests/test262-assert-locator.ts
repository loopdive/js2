/**
 * test262 failure-diagnostic helpers (#1318).
 *
 * A failing test262 test returns the *index* of the first failing assertion
 * (the wrapTest harness sets `__fail = __assert_count`). The runner re-locates
 * that assertion in the original source to build a human-readable `returned N —
 * assert #K at L… : …` diagnostic.
 *
 * This module is side-effect-free so it can be unit-tested directly, unlike the
 * runner modules that open result files at import time.
 */

// Max chars of assertion source surfaced in a `returned N` diagnostic.
// The prior 120-char cap truncated `assert.sameValue(actual, expected, "long
// message...")` mid-line, hiding the actual/expected operands and the message.
// JSONL is one line per test, so a 500-char operand snippet is cheap and makes
// the failure diagnosable.
export const ASSERT_SNIPPET_MAX = 500;

// Detect the start of a test262 assertion / verification call. Covers the
// harness helpers that previously fell through and produced a bare "returned
// N": assert / assert.* , the propertyHelper verify* family, compareArray,
// $DONOTEVALUATE, and `throw new Test262Error`.
export const ASSERT_LINE_RE =
  /(?:^|[;{}\s])(assert\b|assert\.\w+|verify\w+|compareArray\b|\$DONOTEVALUATE\b|throw\s+new\s+Test262Error\b)/;

// Capture the full assertion statement starting at `lines[startLine]`, balancing
// parentheses across line breaks so the actual+expected operands and the
// optional message argument (still present in the original source even though
// wrapTest strips it from the compiled body) are all included. Falls back to a
// single trimmed line when no balanced call is found. Result is capped at
// ASSERT_SNIPPET_MAX chars.
export function extractFullAssert(lines: string[], startLine: number): string {
  const first = lines[startLine];
  const parenIdx = first.indexOf("(");
  if (parenIdx === -1) {
    return first.trim().slice(0, ASSERT_SNIPPET_MAX);
  }
  let depth = 0;
  let started = false;
  const collected: string[] = [];
  for (let i = startLine; i < lines.length && i < startLine + 12; i++) {
    const line = lines[i];
    collected.push(line);
    for (let c = i === startLine ? parenIdx : 0; c < line.length; c++) {
      const ch = line[c];
      if (ch === "(") {
        depth++;
        started = true;
      } else if (ch === ")") {
        depth--;
      }
    }
    if (started && depth <= 0) break;
  }
  const text = collected.join(" ").replace(/\s+/g, " ").trim();
  return text.slice(0, ASSERT_SNIPPET_MAX);
}

// Given a test's source and the assertion-counter value the wrapped test
// returned, build a diagnostic string identifying the failing assertion. Never
// returns a bare "returned N" with zero context.
export function findNthAssert(source: string, retVal: number): string {
  if (retVal === -1) return "exception caught in test body";
  const idx = retVal - 1;
  if (idx < 1) return `early return (${retVal})`;

  const lines = source.split("\n");
  const assertStarts: { line: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (ASSERT_LINE_RE.test(lines[i])) {
      assertStarts.push({ line: i + 1, text: extractFullAssert(lines, i) });
    }
  }

  const target = idx - 1;
  if (target >= 0 && target < assertStarts.length) {
    const a = assertStarts[target];
    return `assert #${idx} at L${a.line}: ${a.text}`;
  }
  // The assertion counter counts every *executed* assert (including those in
  // loops and helper functions), so it can outrun the static source-line scan.
  // When it does, anchor on the LAST assertion in the file — most test262
  // failures land on the final check — so the diagnostic still points at a
  // concrete assertion instead of a bare count.
  if (assertStarts.length > 0) {
    const a = assertStarts[assertStarts.length - 1];
    return `assert #${idx} (counter exceeded ${assertStarts.length} source asserts; last at L${a.line}: ${a.text})`;
  }
  return `assert #${idx} (no assert/verify call found in source — likely a loop body or helper-internal check)`;
}
