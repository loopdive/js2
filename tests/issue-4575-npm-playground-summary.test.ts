import { describe, expect, it } from "vitest";

import { summarizePlaygroundFiles } from "../scripts/lib/npm-compat-playground.mjs";

describe("#4575 npm playground summary", () => {
  it("keeps compile-blocked files out of the skip bucket", () => {
    const files = Array.from({ length: 8 }, (_, index) => ({
      path: `fixture-${index}.js`,
      status: "compile_error",
      passed: 0,
      total: 1,
    }));

    expect(summarizePlaygroundFiles(files)).toEqual({
      pass: 0,
      fail: 0,
      compile_error: 8,
      skip: 0,
      total: 8,
    });
  });

  it("preserves partial pass counts while separating every status", () => {
    expect(
      summarizePlaygroundFiles([
        { path: "pass.js", status: "pass", passed: 2, total: 2 },
        { path: "mixed.js", status: "fail", passed: 1, total: 3 },
        { path: "blocked.js", status: "compile_error", passed: 0, total: 4 },
        { path: "skipped.js", status: "skip", passed: 0, total: 5 },
      ]),
    ).toEqual({
      pass: 3,
      fail: 2,
      compile_error: 4,
      skip: 5,
      total: 14,
    });
  });
});
