// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3314 — parseFrontmatterList / parseFrontmatterCountReason must tolerate
 * blank and `#`-comment lines inside an allow-list frontmatter block.
 *
 * Both scanners used to `break` on the first line that didn't match their
 * expected pattern, which included comment lines — so an allow-list with an
 * explanatory comment *before* the actual list item (exactly the style the
 * gate's own failure message encourages) silently granted nothing. This is
 * what PR #3138 (#3306) hit: its `coercion-sites-allow` declaration was
 * correct per the documented format, but the gate failed as if no
 * allowance existed at all.
 */
import { describe, expect, it } from "vitest";
import { parseFrontmatterCountReason, parseFrontmatterList } from "../scripts/lib/change-scope.mjs";

describe("#3314 frontmatter allow-list parser tolerates comments", () => {
  it("parseFrontmatterList reads a list item preceded by comment lines (the #3138 shape)", () => {
    const text = `---
coercion-sites-allow:
  # __str_to_number +2 — routes through the existing scanner, not a fresh
  # hand-rolled matrix.
  - src/codegen/type-coercion.ts
---
`;
    expect(parseFrontmatterList(text, "coercion-sites-allow")).toEqual(["src/codegen/type-coercion.ts"]);
  });

  it("parseFrontmatterList still stops at a real dedent / trailing top-level key (no over-read)", () => {
    const text = `---
coercion-sites-allow:
  - src/codegen/type-coercion.ts
other-key: value
---
`;
    expect(parseFrontmatterList(text, "coercion-sites-allow")).toEqual(["src/codegen/type-coercion.ts"]);
  });

  it("parseFrontmatterList with no comments still works (regression guard)", () => {
    const text = `---
loc-budget-allow:
  - src/codegen/type-coercion.ts
---
`;
    expect(parseFrontmatterList(text, "loc-budget-allow")).toEqual(["src/codegen/type-coercion.ts"]);
  });

  it("parseFrontmatterCountReason reads count/reason preceded by a comment line", () => {
    const text = `---
regressions-allow:
  # explanatory comment above the scalars
  count: 2700
  reason: "#3285 assert_throws error-type tightening, see #3286"
---
`;
    expect(parseFrontmatterCountReason(text, "regressions-allow")).toEqual({
      count: 2700,
      reason: "#3285 assert_throws error-type tightening, see #3286",
      // (#3596, ed10645f2e) The parser now also returns the optional nested
      // `tests:` list — `[]` when the declaration has none.
      tests: [],
    });
  });

  it("parseFrontmatterCountReason with no comments still works (regression guard)", () => {
    const text = `---
regressions-allow:
  count: 2700
  reason: "plain declaration, no comments"
---
`;
    expect(parseFrontmatterCountReason(text, "regressions-allow")).toEqual({
      count: 2700,
      reason: "plain declaration, no comments",
      tests: [], // (#3596) absent nested `tests:` list parses as []
    });
  });
});
