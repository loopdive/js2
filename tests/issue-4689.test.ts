// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4689 — the direct-string `yield*` residual in ES2015 standalone.
 *
 * The exact Test262 row exercises each delegated character and the terminal
 * `{ value: undefined, done: true }` result. The two green rows are controls
 * for the existing numeric-vec and generic-iterable delegation paths.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

const TEST262_ROOT = join(__dirname, "..", "test262");
const HAS_TEST262 = existsSync(join(TEST262_ROOT, "harness", "assert.js"));

afterEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
});

function pinRow(rel: string, note: string): void {
  it(`${rel} — ${note}`, { timeout: 60_000 }, async () => {
    const file = join(TEST262_ROOT, "test", rel);
    const result = await runTest262File(file, "issue-4689", 30_000, "standalone");
    expect(`${result.status}: ${result.error ?? ""}`).toBe("pass: ");
  });
}

describe.skipIf(!HAS_TEST262)("#4689 — standalone generator yield* pins", () => {
  pinRow(
    "language/expressions/yield/star-string.js",
    "direct string delegation preserves each character and the terminal result",
  );

  // Baseline-pass controls: these exercise the numeric vec and generic
  // iterable delegation arms that the string-specific gate must preserve.
  pinRow("language/expressions/yield/star-array.js", "numeric vec delegation remains green");
  pinRow("language/expressions/yield/rhs-iter.js", "non-delegating iterable-valued yield remains green");
});

describe("#4689 — native string delegation module shape", () => {
  it("keeps direct string delegation host-free and preserves characters", async () => {
    const result = await compile(
      `function* g(): Generator<string> { yield* "abc"; }
export function test(): number { let n = 0; for (const value of g()) n += value.length; return n; }`,
      { fileName: "test.ts", target: "standalone" },
    );
    expect(result.success, result.success ? "" : result.errors?.[0]?.message).toBe(true);
    const module = await WebAssembly.compile(result.binary);
    expect(WebAssembly.Module.imports(module), "direct string delegation must be host-free").toEqual([]);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.test as () => number)()).toBe(3);
  });
});
