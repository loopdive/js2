// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Regression coverage for assignment-form destructuring targets whose lowering
// differs between the GC host and host-free vector/iterator lanes.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const TEST262 = join(__dirname, "..", "test262");
const HAVE_TEST262 = existsSync(join(TEST262, "harness", "assert.js"));
const abs = (relative: string) => join(TEST262, "test", relative);

const REGRESSIONS = [
  "language/expressions/assignment/dstr/array-elem-put-obj-literal-prop-ref.js",
  "language/expressions/assignment/dstr/array-elem-put-obj-literal-prop-ref-init.js",
  "language/expressions/assignment/dstr/array-elem-put-obj-literal-prop-ref-init-active.js",
  "language/expressions/assignment/dstr/array-elem-put-prop-ref-no-get.js",
  "language/expressions/assignment/dstr/obj-prop-elem-target-obj-literal-prop-ref.js",
  "language/statements/for-of/dstr/array-elem-put-obj-literal-prop-ref.js",
  "language/statements/for-of/dstr/array-elem-put-obj-literal-prop-ref-init.js",
  "language/statements/for-of/dstr/array-elem-put-obj-literal-prop-ref-init-active.js",
  "language/statements/for-of/dstr/array-elem-put-prop-ref-no-get.js",
  "language/statements/for-of/dstr/obj-prop-elem-target-obj-literal-prop-ref.js",
  "language/statements/for-of/dstr/array-rest-nested-obj-yield-ident-valid.js",
  "language/statements/for-await-of/async-func-decl-dstr-array-rest-nested-obj-yield-ident-valid.js",
] as const;

const CONTROLS = [
  "language/expressions/assignment/dstr/array-elem-put-prop-ref.js",
  "language/statements/for-of/dstr/array-rest-nested-obj.js",
  "language/statements/for-of/dstr/array-rest-nested-array-yield-ident-valid.js",
] as const;

describe.skipIf(!HAVE_TEST262)("assignment-form destructuring carrier regressions", () => {
  for (const relative of REGRESSIONS) {
    it(`host: ${relative}`, { timeout: 120_000 }, async () => {
      const result = await runTest262File(abs(relative), "host-destructuring-regressions", 30_000);
      expect(result.status, result.reason ?? result.error ?? relative).toBe("pass");
    });

    it(`standalone: ${relative}`, { timeout: 120_000 }, async () => {
      const result = await runTest262File(abs(relative), "host-destructuring-regressions", 30_000, "standalone");
      expect(result.status, result.reason ?? result.error ?? relative).toBe("pass");
    });
  }

  for (const relative of CONTROLS) {
    it(`control host: ${relative}`, { timeout: 120_000 }, async () => {
      const result = await runTest262File(abs(relative), "host-destructuring-regressions", 30_000);
      expect(result.status, result.reason ?? result.error ?? relative).toBe("pass");
    });

    it(`control standalone: ${relative}`, { timeout: 120_000 }, async () => {
      const result = await runTest262File(abs(relative), "host-destructuring-regressions", 30_000, "standalone");
      expect(result.status, result.reason ?? result.error ?? relative).toBe("pass");
    });
  }
});
