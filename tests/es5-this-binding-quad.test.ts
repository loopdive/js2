// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * ES5 receiver/`this` residual cluster:
 *
 * - bare dynamic calls must clear an enclosing `__current_this` receiver;
 * - constructor instances and direct-eval `this` must retain their actual
 *   activation receiver;
 * - compat Function bodies must resolve free names from the running realm.
 *
 * The neighboring rows keep the fixes narrow: the call controls exercise
 * argument evaluation and indexed/member receivers, the `this` control covers
 * ordinary bare calls, and the Function controls cover the adjacent strict /
 * non-strict constructor cases.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { selectCachedRuntimeEvalProvider } from "../scripts/runtime-eval-provider.mjs";
import { runTest262File } from "./test262-runner.js";

const TEST262 = existsSync(resolve("test262", "harness", "assert.js"));

const EXACT_ROWS = [
  "test/language/expressions/call/11.2.3-3_8.js",
  "test/language/expressions/this/S11.1.1_A3.2.js",
  "test/language/function-code/10.4.3-1-83-s.js",
  "test/language/function-code/10.4.3-1-84-s.js",
] as const;

const CONTROLS = [
  "test/language/expressions/call/11.2.3-3_6.js",
  "test/language/expressions/call/11.2.3-3_7.js",
  "test/language/expressions/this/S11.1.1_A3.1.js",
  "test/language/function-code/10.4.3-1-82-s.js",
  "test/language/function-code/10.4.3-1-85-s.js",
  "test/language/function-code/10.4.3-1-86-s.js",
] as const;

const HOST_ROWS = [...EXACT_ROWS, ...CONTROLS];

let liveQuickjsAvailable = false;
try {
  liveQuickjsAvailable = selectCachedRuntimeEvalProvider().engine === "quickjs";
} catch {
  liveQuickjsAvailable = false;
}

async function runRow(file: string, target?: "standalone") {
  return runTest262File(resolve("test262", file), "es5-this-binding-quad", 30_000, target);
}

afterEach(async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
});

describe.skipIf(!TEST262)("ES5 receiver/this residual quad", () => {
  describe("host lane exact rows and neighboring controls", () => {
    for (const file of HOST_ROWS) {
      it(file, { timeout: 60_000 }, async () => {
        const result = await runRow(file);
        expect(`${result.status}: ${result.error ?? ""}`).toBe("pass: ");
      });
    }
  });

  describe("standalone lane receiver controls", () => {
    for (const file of [
      "test/language/expressions/call/11.2.3-3_8.js",
      "test/language/expressions/call/11.2.3-3_6.js",
      "test/language/expressions/call/11.2.3-3_7.js",
      "test/language/expressions/this/S11.1.1_A3.2.js",
      "test/language/expressions/this/S11.1.1_A3.1.js",
      "test/language/function-code/10.4.3-1-82-s.js",
      "test/language/function-code/10.4.3-1-85-s.js",
      "test/language/function-code/10.4.3-1-86-s.js",
    ]) {
      it(file, { timeout: 60_000 }, async () => {
        const result = await runRow(file, "standalone");
        expect(`${result.status}: ${result.error ?? ""}`).toBe("pass: ");
      });
    }
  });

  describe.skipIf(!liveQuickjsAvailable)("standalone lane runtime-eval rows", () => {
    for (const file of [
      "test/language/function-code/10.4.3-1-83-s.js",
      "test/language/function-code/10.4.3-1-84-s.js",
    ]) {
      it(file, { timeout: 120_000 }, async () => {
        const result = await runRow(file, "standalone");
        expect(`${result.status}: ${result.error ?? ""}`).toBe("pass: ");
      });
    }
  });
});
