// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";
import { runTest262File } from "./test262-runner.js";

// The Test262 harness installs helpers through computed function writes such
// as `obj[key] = function () {}`. The object-shape pre-pass must not ask the
// TypeScript checker for those detached functions' contextual types: doing so
// enters its late-bound-symbol path before the parent symbol exists and turns
// otherwise unrelated host rows into compiler crashes.
describe("computed Test262 harness methods remain valid in the host lane", () => {
  const files = [
    "built-ins/Array/from/iter-adv-err.js",
    "language/expressions/array/spread-sngl-iter.js",
    "built-ins/Date/value-to-primitive-call-err.js",
  ] as const;

  for (const file of files) {
    it(file, { timeout: 60_000 }, async () => {
      const result = await runTest262File(resolve("test262/test", file), "computed-harness-method", 30_000);
      restoreHostBuiltins();
      expect(`${result.status}: ${result.error ?? ""}`).toBe("pass: ");
    });
  }
});

describe("inherited strict eval remains completion-neutral", () => {
  const files = [
    "language/eval-code/direct/cptn-nrml-empty-var.js",
    "language/eval-code/direct/strict-caller-global.js",
    "built-ins/String/S9.8_A1_T1.js",
    "language/statements/empty/cptn-value.js",
  ] as const;

  for (const file of files) {
    it(file, { timeout: 60_000 }, async () => {
      const result = await runTest262File(resolve("test262/test", file), "strict-eval-completion", 30_000);
      restoreHostBuiltins();
      expect(`${result.status}: ${result.error ?? ""}`).toBe("pass: ");
    });
  }
});

describe("host arguments objects keep their native lowering", () => {
  const files = [
    "built-ins/Array/prototype/every/15.4.4.16-7-c-ii-11.js",
    "built-ins/Error/prototype/stack/setter-no-argument.js",
    "built-ins/ThrowTypeError/extensible.js",
  ] as const;

  for (const file of files) {
    it(file, { timeout: 60_000 }, async () => {
      const result = await runTest262File(resolve("test262/test", file), "host-arguments", 30_000);
      restoreHostBuiltins();
      expect(`${result.status}: ${result.error ?? ""}`).toBe("pass: ");
    });
  }
});
