// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 Stage 4 (M1) — a VOID-result function-object member closure in
// `<module-init>` (assert.js's `assert.sameValue = function (actual, expected,
// message) { … }`) is planned and lowered by the IR: legacy registers it with
// no result, so the plan carries a void signature (not an invented dynamic
// one); its body may early-`return;` from inside try/if, reassign a dynamic
// parameter (`message += ' '`), test `message === undefined`, and call a
// sibling member. Every program is also run under node and must agree.

import { describe, expect, it, vi } from "vitest";
import { compile, type CompileResult } from "../src/index.js";

const OPTIONS = {
  target: "standalone",
  skipSemanticDiagnostics: true,
  trackIrOutcomes: true,
  deferTopLevelInit: true,
} as const;

function row(result: CompileResult, name: string) {
  const rows = (result.irOutcomes ?? []).filter((entry) => entry.displayName === name);
  expect(rows, JSON.stringify(result.irOutcomes)).toHaveLength(1);
  return rows[0]!;
}

function requirePrepared(result: CompileResult, name: string): void {
  expect(row(result, name)).toMatchObject({
    kind: "emitted",
    irBodyEmitted: true,
    legacyBodyEmitted: false,
    preparedComponentId: expect.any(String),
  });
}

async function initializeAndRun(result: CompileResult): Promise<number> {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  (instance.exports.__module_init as () => void)();
  return (instance.exports.run as () => number)();
}

function node(source: string): number {
  return new Function(`"use strict";\n${source.replace(/\bexport /g, "")}\nreturn run();`)() as number;
}

const SAME_VALUE = `function subject() { return 0; }
subject.is = function (a, b) { return a === b; };
subject.same = function (actual, expected, message) {
  try {
    if (subject.is(actual, expected)) {
      return;
    }
  } catch (error) {
    throw error;
  }
  if (message === undefined) {
    message = '';
  } else {
    message += ' ';
  }
  message += 'Expected ' + actual;
  throw message;
};
export function run() {
  var n = 0;
  try { subject.same(1, 1); n += 1; } catch (e) { n += 10; }
  try { subject.same(1, 2, "m"); n += 100; } catch (e) { n += 1000; }
  try { subject.same(3, 4); n += 100; } catch (e) { n += 10000; }
  return n;
}`;

describe("#7106 Stage 4 — void-result function-member closures in <module-init>", () => {
  it("prepares an assert.sameValue-shaped initializer and runs it like node", async () => {
    const result = await compile(SAME_VALUE, OPTIONS);
    for (const name of ["subject", "<module-init>"]) requirePrepared(result, name);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(node(SAME_VALUE)).toBe(11001);
    expect(await initializeAndRun(result)).toBe(11001);
  }, 35_000);

  it("builds the thrown message through the reassigned dynamic parameter", async () => {
    const source = SAME_VALUE.replace(
      /export function run\(\) \{[\s\S]*$/,
      `export function run() {
  var n = 0;
  try { subject.same(1, 2, "m"); } catch (e) { if (e === "m Expected 1") n += 1; }
  try { subject.same(1, 2); } catch (e) { if (e === "Expected 1") n += 10; }
  return n;
}`,
    );
    const result = await compile(source, OPTIONS);
    requirePrepared(result, "<module-init>");
    expect(node(source)).toBe(11);
    expect(await initializeAndRun(result)).toBe(11);
  }, 35_000);

  it("a member closure's early return does not inherit module-init's return barrier", async () => {
    const source = `function subject() { return 0; }
subject.check = function (a, b) { if (a === b) { return; } throw a; };
export function run() {
  var n = 0;
  try { subject.check(1, 1); n += 1; } catch (e) { n += 10; }
  try { subject.check(1, 2); n += 100; } catch (e) { n += 1000; }
  return n;
}`;
    const result = await compile(source, OPTIONS);
    requirePrepared(result, "<module-init>");
    expect(node(source)).toBe(1001);
    expect(await initializeAndRun(result)).toBe(1001);
  }, 35_000);

  it("keeps a closure that returns a value or reads `this` off the void plan", async () => {
    const source = `function subject() { return 0; }
subject.self = function (a) { if (a === 1) { return; } this.x = a; };
export function run() { subject.self(1); return 1; }`;
    const result = await compile(source, OPTIONS);
    expect(row(result, "<module-init>").irBodyEmitted).toBe(false);
    expect(await initializeAndRun(result)).toBe(1);
  }, 35_000);
});

describe("#7106 Stage 4 — an abandoned lifted member closure", () => {
  it("rebinds the source unit to the legacy allocation when its owner fails preparation", async () => {
    vi.stubEnv("JS2WASM_TEST_INJECT_IR_PREPARED_SEAL_FAILURE", "1");
    try {
      const source = `function subject() { return 0; }
subject.equal = function (a, b) { return a === b; };
export function run() { return subject.equal(1, 1) ? 1 : 0; }`;
      const result = await compile(source, OPTIONS);
      // Before: "retained source callable __closure_N is not the exact allocator
      // owned by …" failed the whole compile.
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(row(result, "<module-init>")).toMatchObject({ code: "late-preparation-unsupported" });
      expect(await initializeAndRun(result)).toBe(1);
    } finally {
      vi.unstubAllEnvs();
    }
  }, 35_000);
});
