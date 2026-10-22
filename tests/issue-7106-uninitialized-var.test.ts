// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 Stage 4 (M2) — an untyped function-local `var x;` with no initializer
// (assert.throws' `var expectedName, actualName;`) is the dynamic carrier's
// `undefined` until assigned, in a top-level function and in a planned
// function-member closure of `<module-init>`. A `var x;` inside a loop stays
// legacy (a re-executed `var x;` keeps its value). Results are checked
// against node.

import { describe, expect, it } from "vitest";
import { compile, type CompileResult } from "../src/index.js";

type Outcome = NonNullable<CompileResult["irOutcomes"]>[number];

function row(result: CompileResult, name: string): Outcome {
  const rows = (result.irOutcomes ?? []).filter((entry) => entry.displayName === name);
  expect(rows, JSON.stringify(result.irOutcomes)).toHaveLength(1);
  return rows[0]!;
}

function node(source: string, name: string): number {
  return new Function(`"use strict";\n${source.replace(/\bexport /g, "")}\nreturn ${name}();`)() as number;
}

describe("#7106 Stage 4 — `var x;` as the dynamic undefined", () => {
  it("binds an uninitialized var in a top-level function and in the loop-free case only", async () => {
    const source = `
      /** @param {object} o */
      function keep(o) {
        var a;
        if (o === null) {
          a = o;
        }
        return a;
      }
      /** @param {object} o */
      function inLoop(o) {
        for (var i = 0; i < 2; i++) {
          var v;
          if (i === 1) {
            if (v === undefined) return 1;
            return 0;
          }
          v = o;
        }
        return 2;
      }
      export function t() {
        var n = 0;
        if (keep({}) === undefined) n += 1;
        if (keep(null) === null) n += 10;
        n += inLoop({}) * 100;
        return n;
      }
    `;
    const result = await compile(source, {
      experimentalIR: true,
      skipSemanticDiagnostics: true,
      allowJs: true,
      target: "standalone",
      trackIrOutcomes: true,
      fileName: "issue-7106-uninit-var.js",
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(row(result, "keep").irBodyEmitted).toBe(true);
    expect(row(result, "inLoop").irBodyEmitted).toBe(false);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect(node(source, "t")).toBe(11);
    expect((instance.exports.t as () => number)()).toBe(11);
  }, 35_000);

  it("prepares a module-init member closure that declares `var seen, other;`", async () => {
    const source = `/** @returns {number} */ function subject() { return 0; }
subject.check = function (value, message) {
  var seen, other;
  if (value === undefined) {
    seen = 'u';
  } else {
    seen = value;
  }
  if (other === undefined) {
    throw seen;
  }
};
export function run() {
  var n = 0;
  try { subject.check(undefined); } catch (e) { if (e === 'u') n += 1; }
  try { subject.check(5); } catch (e) { if (e === 5) n += 10; }
  return n;
}`;
    const result = await compile(source, {
      target: "standalone",
      skipSemanticDiagnostics: true,
      trackIrOutcomes: true,
      deferTopLevelInit: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(row(result, "<module-init>")).toMatchObject({
      irBodyEmitted: true,
      legacyBodyEmitted: false,
      preparedComponentId: expect.any(String),
    });
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    (instance.exports.__module_init as () => void)();
    expect(node(source, "run")).toBe(11);
    expect((instance.exports.run as () => number)()).toBe(11);
  }, 35_000);
});
