// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7130 (#7106 integrated census, step 2) — an unannotated closure literal
// passed as an ARGUMENT to a same-source top-level function value
// (`assert.throws(E, function () {…})`, `run(function () {…})`) gets the
// member-closure plan: legacy's own physical signature, dynamic parameters, a
// void/boolean/string result. Before, every such closure in a script was
// refused with `closure-return-type`, which kept `<module-init>` legacy in
// 59/266 sampled test262 files. A module-scope `var` the closure reads or
// writes is the same `__mod_` global, not a captured slot.
//
// Every program is a script whose checks throw; it must agree with node and
// with the legacy compile of the same source.
import { describe, expect, it } from "vitest";

import { compile, type CompileResult } from "../src/index.js";

const OPTIONS = {
  fileName: "issue-7130.js",
  allowJs: true,
  skipSemanticDiagnostics: true,
  inferModuleStrictArguments: false,
  scriptGoal: true,
  deferTopLevelInit: true,
  trackIrOutcomes: true,
  target: "standalone",
} as const;

function moduleInit(result: CompileResult) {
  return (result.irOutcomes ?? []).find((row) => row.displayName === "<module-init>");
}

function node(source: string): string {
  try {
    new Function(source)();
    return "ok";
  } catch (error) {
    return `threw ${String(error)}`;
  }
}

async function run(source: string, legacy = false): Promise<{ result: CompileResult; verdict: string }> {
  const result = await compile(source, {
    ...OPTIONS,
    ...(legacy ? { experimentalIR: false } : {}),
  } as Parameters<typeof compile>[1]);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  try {
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    (instance.exports.__module_init as () => void)();
    return { result, verdict: "ok" };
  } catch {
    return { result, verdict: "threw" };
  }
}

const CALLEE = `/** @returns {number} */ function subject() { return 0; }
subject.run = function (fn) { fn(); };
subject.give = function (fn) { fn(5, "s"); };
`;

const CASES: Record<string, string> = {
  writesModuleVar: `${CALLEE}var hits = 0;
subject.run(function () { hits = hits + 1; });
subject.run(function () { hits = hits + 10; });
if (hits !== 11) { throw "hits"; }`,
  // (A module `var` that receives a dynamic value has no representable slot
  // yet — census step 3 — so these check inside the closure.)
  readsDynamicParams: `${CALLEE}subject.give(function (n, s) { if (n !== 5 || s !== "s") { throw "params"; } });`,
  callsBuiltinMethodOnParam: `${CALLEE}subject.give(function (n) { if (n.toString() !== "5") { throw "toString"; } });`,
  insideABlock: `${CALLEE}var hits = 0;
if (hits === 0) { subject.run(function () { hits = 7; }); }
if (hits !== 7) { throw "block"; }`,
};

describe("#7130 — closure literals passed to a top-level function value", () => {
  for (const [name, source] of Object.entries(CASES)) {
    it(`${name}: <module-init> is IR and agrees with node and legacy`, async () => {
      expect(node(source)).toBe("ok");
      const { result, verdict } = await run(source);
      expect(moduleInit(result)?.irBodyEmitted, JSON.stringify(moduleInit(result))).toBe(true);
      expect(verdict).toBe("ok");
      expect((await run(source, true)).verdict, "legacy compile").toBe("ok");
      // A wrong expectation must still throw from the IR body.
      const wrong = source.replace(/!== (11|5|7|"5")(?![0-9])/, "!== 12345");
      expect(wrong).not.toBe(source);
      expect(node(wrong)).not.toBe("ok");
      const failing = await run(wrong);
      expect(moduleInit(failing.result)?.irBodyEmitted).toBe(true);
      expect(failing.verdict).toBe("threw");
      expect((await run(wrong, true)).verdict, "legacy compile").toBe("threw");
    }, 60_000);
  }

  it("leaves a builtin callee's callback to its own lowering contract", async () => {
    const source = `var sum = 0;
[1, 2].forEach(function (x) { sum = sum + x; });
if (sum !== 3) { throw "sum"; }`;
    expect(node(source)).toBe("ok");
    const { result, verdict } = await run(source);
    expect(moduleInit(result)?.irBodyEmitted).toBe(false);
    expect(verdict).toBe("ok");
  }, 60_000);
});
