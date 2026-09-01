// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Standalone transition residuals from the pre-#5202 audit.
 *
 * These rows pin the three shared mechanisms repaired here:
 *   - TypedArray.prototype.filter must perform TypedArraySpeciesCreate on the
 *     original dynamic view, not on the internal materialized f64 vector.
 *   - Closure parameter binding patterns must use the shared destructuring
 *     lowering so nested/default bindings behave like declarations.
 *   - Native-string standalone modules must still emit literal property keys
 *     for externref object destructuring.
 *
 * The async-generator and for-await rows are included because they exercise
 * the same closure/destructuring path after suspension; the named yield-star
 * row is a passing control from the same historic sample.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const TEST262_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "test262");
const HAVE_TEST262 = existsSync(join(TEST262_ROOT, "harness", "assert.js"));
const RUNNER_TIMEOUT = 120_000;
const TEST_TIMEOUT = 180_000;

const TYPED_ARRAY_ROWS = [
  "built-ins/TypedArray/prototype/filter/speciesctor-get-species.js",
  "built-ins/TypedArray/prototype/filter/BigInt/speciesctor-get-species.js",
  "built-ins/TypedArray/prototype/filter/speciesctor-get-species-custom-ctor-length.js",
  "built-ins/TypedArray/prototype/filter/BigInt/speciesctor-get-species-custom-ctor-length.js",
  "built-ins/TypedArray/prototype/filter/speciesctor-get-species-custom-ctor-length-throws.js",
] as const;

const CLOSURE_DESTRUCTURING_ROWS = [
  "language/expressions/arrow-function/dstr/dflt-ary-ptrn-elem-obj-id-init.js",
  "language/expressions/arrow-function/dstr/dflt-obj-ptrn-id-init-throws.js",
  "language/expressions/function/dstr/dflt-ary-ptrn-elem-obj-id-init.js",
  "language/expressions/generators/dstr/dflt-obj-ptrn-id-init-skipped.js",
  "language/expressions/class/dstr/gen-meth-obj-ptrn-prop-obj.js",
] as const;

const ASYNC_DESTRUCTURING_ROWS = [
  "language/expressions/async-generator/named-yield-star-getiter-async-not-callable-boolean-throw.js",
  "language/expressions/async-generator/dstr/dflt-ary-ptrn-elem-obj-id-init.js",
  "language/expressions/async-generator/dstr/dflt-obj-ptrn-id-trailing-comma.js",
  "language/statements/for-await-of/async-func-decl-dstr-array-elem-put-prop-ref-user-err.js",
  "language/statements/for-await-of/async-func-dstr-const-obj-ptrn-id-init-throws.js",
] as const;

async function expectStandalonePass(relativePath: string): Promise<void> {
  const result = await runTest262File(
    join(TEST262_ROOT, "test", relativePath),
    "standalone-transition-residuals",
    RUNNER_TIMEOUT,
    "standalone",
  );
  expect(result.status, `${relativePath}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
}

describe.skipIf(!HAVE_TEST262)("standalone transition residuals", () => {
  it.each(TYPED_ARRAY_ROWS)("TypedArray species: %s", { timeout: TEST_TIMEOUT }, async (relativePath) => {
    await expectStandalonePass(relativePath);
  });

  it.each(CLOSURE_DESTRUCTURING_ROWS)(
    "closure destructuring defaults: %s",
    { timeout: TEST_TIMEOUT },
    async (relativePath) => {
      await expectStandalonePass(relativePath);
    },
  );

  it.each(ASYNC_DESTRUCTURING_ROWS)("async destructuring: %s", { timeout: TEST_TIMEOUT }, async (relativePath) => {
    await expectStandalonePass(relativePath);
  });
});
