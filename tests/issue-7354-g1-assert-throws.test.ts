// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 G1 — `assert.throws(C, fn)` of the real test262 harness (the runner's shim + assert.js + sta.js) through the
// strict Prepared entry with the runner's options: the harness compares `thrown.constructor !== C` and reads
// `C.name` / `thrown.constructor.name`, so it passes only where the realm's and the program's errors carry their
// constructors. Each row passes as written and fails (a Test262Error) with the wrong constructor.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPrepared, runnerOptions } from "./helpers/prepared-node-agreement.js";

afterEach(() => vi.restoreAllMocks());

const ROOT = join(__dirname, "..");
const TEST262 = existsSync(join(ROOT, "test262", "harness", "assert.js"));
const SLOW = 300_000;
const prelude = (): string =>
  [
    join(ROOT, "scripts", "test262-fyi-runtime.js"),
    ...["assert.js", "sta.js"].map((f) => join(ROOT, "test262", "harness", f)),
  ]
    .map((file) => readFileSync(file, "utf8"))
    .join("");

/** `[label, constructor thrown, the throwing function's body]`. */
const ROWS: readonly (readonly [string, string, string])[] = [
  ["the realm's TypeError (a nullish member read)", "TypeError", "g(null);"],
  ["the realm's TypeError (a call of a non-callable)", "TypeError", "h(1);"],
  ["a program's RangeError", "RangeError", "throw new RangeError('r');"],
  ["a program's SyntaxError by the call form", "SyntaxError", "throw SyntaxError('s');"],
];

describe.skipIf(!TEST262)("#7354 G1 — assert.throws through the real harness", () => {
  it.each(ROWS)(
    "%s",
    async (_label, thrown, body) => {
      const program = (expected: string) =>
        `${prelude()}function g(o) { return o.x; }\nfunction h(f) { return f(); }\n` +
        `assert.throws(${expected}, function () { ${body} });\n`;
      expect(await runPrepared(program(thrown), runnerOptions())).toBe("returned");
      const wrong = thrown === "TypeError" ? "RangeError" : "TypeError";
      expect(await runPrepared(program(wrong), runnerOptions())).toBe("threw");
    },
    SLOW,
  );
  it(
    "a function that throws nothing fails the assertion",
    async () => {
      expect(await runPrepared(`${prelude()}assert.throws(TypeError, function () {});\n`, runnerOptions())).toBe(
        "threw",
      );
    },
    SLOW,
  );
});
