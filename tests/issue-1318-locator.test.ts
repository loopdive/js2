/**
 * #1318 (follow-up) — assertion-locator parity for the SHARDED CI runner.
 *
 * The original #1318 fix (commit 39fa6ef3f) improved the `runTest262File`
 * smoke-test path. The sharded CI runner (tests/test262-shared.ts via the
 * test262-chunk*.test.ts files) and the legacy tests/test262-vitest.test.ts
 * still used the old findNthAssert: a 120-char cap, a narrow assert regex, and
 * a bare "returned N" fallback when the assertion counter outran the static
 * source scan. Both now share tests/test262-assert-locator.ts. These tests pin
 * the shared helper's behavior.
 */
import { describe, expect, it } from "vitest";
import { findNthAssert, extractFullAssert, ASSERT_SNIPPET_MAX } from "./test262-assert-locator.js";

describe("#1318 findNthAssert (shared locator)", () => {
  // wrapTest sets __assert_count = 1 then pre-increments per assert, so the Kth
  // assert (1-based) sets __fail = K + 1 → retVal = K + 1.
  const source = [
    "var x = foo();",
    'assert.sameValue(x, 1, "first check");',
    'assert.sameValue(x, 2, "second check");',
    'assert.sameValue(x, 3, "third check");',
  ].join("\n");

  it("locates the first failing assertion (retVal=2 → assert #1)", () => {
    const msg = findNthAssert(source, 2);
    expect(msg).toContain("assert #1");
    expect(msg).toContain("L2");
    expect(msg).toContain("first check");
  });

  it("locates the second failing assertion (retVal=3 → assert #2)", () => {
    const msg = findNthAssert(source, 3);
    expect(msg).toContain("assert #2");
    expect(msg).toContain("L3");
    expect(msg).toContain("second check");
  });

  it("surfaces actual+expected operands AND the (stripped-from-body) message arg", () => {
    const msg = findNthAssert(source, 4);
    expect(msg).toContain("third check");
    expect(msg).toMatch(/x\s*,\s*3/);
  });

  it("never returns a bare 'returned N'/'found M asserts' when the counter outruns the scan", () => {
    const loopSource = ["for (var i = 0; i < 100; i++) {", '  assert.sameValue(arr[i], i, "loop check");', "}"].join(
      "\n",
    );
    const msg = findNthAssert(loopSource, 50);
    expect(msg).toContain("counter exceeded");
    expect(msg).toContain("loop check");
    expect(msg).not.toMatch(/\(found \d+ asserts in source\)$/);
  });

  it("gives a descriptive fallback when no assert call exists in source", () => {
    const msg = findNthAssert("var y = 1;\nthrow y;", 5);
    expect(msg).toContain("no assert/verify call found");
  });

  it("handles the exception sentinel and early-return cases", () => {
    expect(findNthAssert(source, -1)).toBe("exception caught in test body");
    expect(findNthAssert(source, 1)).toContain("early return");
  });

  it("detects verifyProperty / compareArray / Test262Error harness forms", () => {
    const s = [
      "var d = {};",
      "verifyProperty(d, 'x', { value: 1 });",
      "assert(compareArray([1], [1]), 'arrays');",
      'throw new Test262Error("boom");',
    ].join("\n");
    expect(findNthAssert(s, 2)).toContain("verifyProperty");
    expect(findNthAssert(s, 3)).toContain("compareArray");
    expect(findNthAssert(s, 4)).toContain("Test262Error");
  });
});

describe("#1318 extractFullAssert (shared locator)", () => {
  it("captures a multi-line assertion call by balancing parens", () => {
    const lines = [
      "assert.sameValue(",
      "  computeValue(input),",
      "  expectedValue,",
      '  "a long descriptive message"',
      ");",
    ];
    const text = extractFullAssert(lines, 0);
    expect(text).toContain("computeValue(input)");
    expect(text).toContain("expectedValue");
    expect(text).toContain("a long descriptive message");
  });

  it("does not truncate below the old 120-char cap", () => {
    const longMsg = "x".repeat(400);
    const lines = [`assert.sameValue(actual, expected, "${longMsg}");`];
    const text = extractFullAssert(lines, 0);
    expect(text.length).toBeGreaterThan(120);
    expect(text).toContain(longMsg.slice(0, 300));
  });

  it("caps very long assertions at ASSERT_SNIPPET_MAX", () => {
    const longMsg = "y".repeat(2000);
    const lines = [`assert.sameValue(actual, expected, "${longMsg}");`];
    const text = extractFullAssert(lines, 0);
    expect(text.length).toBeLessThanOrEqual(ASSERT_SNIPPET_MAX);
  });
});
