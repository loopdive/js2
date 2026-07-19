// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { rewriteScriptTopLevelThis, runTest262File } from "./test262-runner.js";

describe("#3367 project-runner assignment wrapper gap", () => {
  it("rewrites only Script code that inherits top-level this", () => {
    const source = `
      var direct = this;
      var arrow = () => this;
      function ordinary() { return this; }
      class C { method() { return this; } }
    `;
    const rewritten = rewriteScriptTopLevelThis(source);

    expect(rewritten).toContain("var direct = (globalThis as any)");
    expect(rewritten).toContain("var arrow = () => (globalThis as any)");
    expect(rewritten).toContain("function ordinary() { return this; }");
    expect(rewritten).toContain("class C { method() { return this; } }");
  });

  it("matches the original harness across the deterministic 20-test assignment sample", async () => {
    const paths = [
      "annexB/language/expressions/assignment/dstr/array-pattern-emulates-undefined.js",
      "annexB/language/expressions/assignment/dstr/object-pattern-emulates-undefined.js",
      "annexB/language/expressions/assignmenttargettype/callexpression-as-for-in-lhs.js",
      "annexB/language/expressions/assignmenttargettype/callexpression-as-for-of-lhs.js",
      "annexB/language/expressions/assignmenttargettype/callexpression-in-compound-assignment.js",
      "annexB/language/expressions/assignmenttargettype/callexpression-in-postfix-update.js",
      "annexB/language/expressions/assignmenttargettype/callexpression-in-prefix-update.js",
      "annexB/language/expressions/assignmenttargettype/callexpression.js",
      "annexB/language/expressions/assignmenttargettype/cover-callexpression-and-asyncarrowhead.js",
      "language/expressions/assignment/11.13.1-1-6-s.js",
      "language/expressions/assignment/11.13.1-1-s.js",
      "language/expressions/assignment/11.13.1-2-s.js",
      "language/expressions/assignment/11.13.1-3-s.js",
      "language/expressions/assignment/11.13.1-4-1.js",
      "language/expressions/assignment/11.13.1-4-14-s.js",
      "language/expressions/assignment/11.13.1-4-27-s.js",
      "language/expressions/assignment/11.13.1-4-28gs.js",
      "language/expressions/assignment/11.13.1-4-29gs.js",
      "language/expressions/assignment/11.13.1-4-3-s.js",
      "language/expressions/assignment/11.13.1-4-6-s.js",
    ];
    const results = [];
    for (const path of paths) {
      const category = path.startsWith("annexB/") ? "annexB" : "language";
      results.push(await runTest262File(resolve("test262/test", path), category));
    }

    expect(results.map(({ file, status, error }) => ({ file, status, error }))).toEqual(
      paths.map((path) => ({ file: `test/${path}`, status: "pass", error: undefined })),
    );
  }, 120_000);
});
