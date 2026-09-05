// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4716 — for-of IteratorClose must resume a native generator on abrupt exit.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const GENERATOR_CLOSE = [
  "language/statements/for-of/generator-close-via-break.js",
  "language/statements/for-of/generator-close-via-return.js",
] as const;

const ITERATOR_CLOSE_CONTROLS = [
  "language/statements/for-of/generator-close-via-continue.js",
  "language/statements/for-of/iterator-close-via-break.js",
  "language/statements/for-of/iterator-close-via-return.js",
  "language/statements/for-of/iterator-close-via-throw.js",
] as const;

const LANES = [
  { name: "host", target: undefined },
  { name: "standalone", target: "standalone" as const },
] as const;

describe("#4716 ES2015 for-of generator IteratorClose", () => {
  for (const lane of LANES) {
    it.each(GENERATOR_CLOSE)("passes %s in the %s lane", async (file) => {
      const result = await runTest262File(
        join("test262/test", file),
        "language/statements/for-of",
        30_000,
        lane.target,
      );
      expect(result.status, `${lane.name} ${file}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
    });

    it.each(ITERATOR_CLOSE_CONTROLS)("keeps %s passing in the %s lane", async (file) => {
      const result = await runTest262File(
        join("test262/test", file),
        "language/statements/for-of",
        30_000,
        lane.target,
      );
      expect(result.status, `${lane.name} ${file}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
    });
  }
});
