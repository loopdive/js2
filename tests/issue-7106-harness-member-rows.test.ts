// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 Stage 4 — the last two harness `<module-init>` rows that are member
// closures:
//   - row 1, assert.compareArray's `var format = compareArray.format;` then
//     `format(actual)`: a function-object member READ (a receiver-only use of
//     the boxed function object) and a call through the dynamic local;
//   - row 3, sta.js's `Test262Error.prototype.toString = function () { return
//     "Test262Error: " + this.message; }`: the chained `F.p.x = fn` store, a
//     STRING result and a closure that binds its own `this` at entry.
// Every result is checked against node. Two harness lines are still selector
// refusals, and the honest harness census below pins them: row 2
// (`compareArray.format`'s `Array.prototype.map.call(…)` body) and
// assert.compareArray's `message = message.toString();`, a method call on a
// dynamic receiver, which #7110 keeps legacy (the IR's dynamic method call has
// no primitive/vec brand arms on the host-free lanes). Behind them,
// assert.compareArray's `String(message)` calls are #7113's standalone
// `closure-carrier-helper-call` cut (`String(carrier)` in a closure that mints
// a carrier join needs `prepared-dynamic-helper-abi`, wasi-only today).
import vm from "node:vm";
import { describe, expect, it } from "vitest";

import { compile, type CompileResult } from "../src/index.js";
import { assembleOriginalHarness } from "./test262-original-harness.js";
import { parseMeta } from "./test262-runner.js";

const OPTIONS = {
  target: "standalone",
  skipSemanticDiagnostics: true,
  trackIrOutcomes: true,
  deferTopLevelInit: true,
} as const;

function initRow(result: CompileResult) {
  return (result.irOutcomes ?? []).find((entry) => entry.displayName === "<module-init>");
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

describe("#7106 Stage 4 — function-object member reads in member closures (row 1)", () => {
  it("reads F.member into a var and calls through it", async () => {
    const source = `function cmp(a, b) {
  return a === b;
}
function fmt(v) {
  return "<" + String(v) + ">";
}
cmp.format = fmt;
function subject() {}
subject.check = function (actual, expected, message) {
  if (cmp(actual, expected)) return;
  var format = cmp.format;
  throw "Actual " + format(actual) + " expected " + format(expected) + " " + String(message);
};
export function run() {
  var n = 0;
  try {
    subject.check(1, 2, "m");
  } catch (e) {
    if (e === "Actual <1> expected <2> m") n += 1;
  }
  try {
    subject.check(3, 3, "m");
    n += 10;
  } catch (e) {
    n += 100;
  }
  return n;
}`;
    const result = await compile(source, OPTIONS);
    expect(initRow(result), JSON.stringify(result.irOutcomes)).toMatchObject({ irBodyEmitted: true });
    expect((result.irPostClaimErrors ?? []).filter((error) => error.func === "<module-init>")).toEqual([]);
    expect(node(source)).toBe(11);
    expect(await initializeAndRun(result)).toBe(11);
  }, 35_000);
});

describe("#7106 Stage 4 — string results and `this` in member closures (row 3)", () => {
  const source = `function E(message) {
  if (!(this instanceof E)) return new E(message);
  this.message = message || "";
}
E.prototype.toString = function () {
  return "E: " + this.message;
};
E.label = function (value) {
  return "<" + String(value) + ">";
};
E.self = function () {
  return "self:" + typeof this;
};
export function run() {
  var n = 0;
  if (String(new E("m")) === "E: m") n += 1;
  if (new E("q").toString() === "E: q") n += 10;
  if (String(E("x")) === "E: x") n += 100;
  if (E.label(2) === "<2>") n += 1000;
  if (E.self() === "self:function") n += 10000;
  return n;
}`;

  it("plans the chained prototype store, the string results and the entry-bound `this`", async () => {
    const result = await compile(source, OPTIONS);
    expect(initRow(result), JSON.stringify(result.irOutcomes)).toMatchObject({ irBodyEmitted: true });
    expect((result.irPostClaimErrors ?? []).filter((error) => error.func === "<module-init>")).toEqual([]);
    expect(node(source)).toBe(11111);
    expect(await initializeAndRun(result)).toBe(11111);
  }, 35_000);

  it("leaves a prototype method of an approved fnctor to legacy", async () => {
    const fnctor = `function P(x) {
  this.x = x;
}
P.prototype.get = function () {
  return "v" + this.x;
};
export function run() {
  var p = new P(1);
  return p.get() === "v1" ? 1 : 0;
}`;
    const result = await compile(fnctor, OPTIONS);
    expect(initRow(result)?.irBodyEmitted).toBe(false);
    expect(node(fnctor)).toBe(1);
    expect(await initializeAndRun(result)).toBe(1);
  }, 35_000);
});

describe("#7106 Stage 4 — honest harness census", () => {
  const BODY = `/*---
description: Test262Error.prototype.toString through the IR module initializer
---*/
assert.sameValue(String(new Test262Error("m")), "Test262Error: m");
assert.sameValue(new Test262Error("q").toString(), "Test262Error: q");
assert.notSameValue(1, 2);
`;
  const ROW_2 = `return "[" + Array.prototype.map.call(arrayLike, String).join(", ") + "]";`;
  const SYMBOL_MESSAGE = `message = message.toString();`;
  const STRING_MESSAGE = `+ String(message)`;

  /** `stub` replaces the refused harness lines with IR-buildable twins. */
  function assemble(source: string, stub: boolean): string {
    const assembled = assembleOriginalHarness(source, parseMeta(source) as never).primary.source;
    expect(assembled).toContain(ROW_2);
    expect(assembled).toContain(SYMBOL_MESSAGE);
    expect(assembled).toContain(STRING_MESSAGE);
    return stub
      ? assembled
          .replace(ROW_2, `return "[" + String(arrayLike) + "]";`)
          .replace(SYMBOL_MESSAGE, `message = "" + message;`)
          .replaceAll(STRING_MESSAGE, `+ message`)
      : assembled;
  }

  async function compileHarness(source: string) {
    return compile(source, {
      fileName: "test.js",
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "standalone",
      inferModuleStrictArguments: false,
      scriptGoal: true,
      deferTopLevelInit: true,
      hostBridge: "always",
      trackIrOutcomes: true,
    } as Parameters<typeof compile>[1]);
  }

  async function runHarness(result: CompileResult): Promise<void> {
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const exports = instance.exports as Record<string, (() => void) | undefined>;
    exports.__module_init?.();
    exports.test?.();
  }

  it("the unstubbed harness keeps <module-init> legacy", async () => {
    const result = await compileHarness(assemble(BODY, false));
    expect(result.success).toBe(true);
    expect(initRow(result)).toMatchObject({ irBodyEmitted: false, code: "body-shape-rejected" });
  }, 60_000);

  it("with the refused lines stubbed, every harness unit and <module-init> ship IR bodies and agree with node", async () => {
    const assembled = assemble(BODY, true);
    vm.runInContext(assembled, vm.createContext({ console }));
    const result = await compileHarness(assembled);
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const legacy = (result.irOutcomes ?? []).filter((row) => row.kind !== "non-executable" && !row.irBodyEmitted);
    expect(legacy, JSON.stringify(legacy)).toEqual([]);
    await expect(runHarness(result)).resolves.toBeUndefined();
    const wrong = await compileHarness(assembled.replace(`"Test262Error: q")`, `"Test262Error: z")`));
    expect(initRow(wrong)?.irBodyEmitted).toBe(true);
    await expect(runHarness(wrong)).rejects.toBeDefined();
  }, 60_000);
});
