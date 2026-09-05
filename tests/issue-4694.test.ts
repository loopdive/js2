// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const ROWS = [
  "built-ins/RegExp/named-groups/string-replace-get.js",
  "built-ins/RegExp/named-groups/string-replace-missing.js",
  "built-ins/RegExp/named-groups/string-replace-numbered.js",
  "built-ins/RegExp/named-groups/string-replace-unclosed.js",
  "built-ins/RegExp/named-groups/string-replace-undefined.js",
  "built-ins/RegExp/named-groups/string-replace-escaped.js",
  "built-ins/RegExp/named-groups/string-replace-nocaptures.js",
  "built-ins/RegExp/prototype/Symbol.replace/subst-after.js",
  "built-ins/RegExp/prototype/Symbol.replace/subst-before.js",
  "built-ins/RegExp/prototype/Symbol.replace/subst-capture-idx-1.js",
  "built-ins/RegExp/prototype/Symbol.replace/subst-capture-idx-2.js",
  "built-ins/RegExp/prototype/Symbol.replace/subst-dollar.js",
  "built-ins/RegExp/prototype/Symbol.replace/subst-matched.js",
  "built-ins/RegExp/prototype/Symbol.replace/named-groups.js",
] as const;

describe("#4694 — dynamic named-group string replacement", () => {
  it.each(ROWS)("passes the exact standalone Test262 row %s", async (file) => {
    const result = await runTest262File(join("test262/test", file), "issue-4694", 120_000, "standalone");
    expect(result.status, result.error ?? `unexpected status for ${file}`).toBe("pass");
  });
});
