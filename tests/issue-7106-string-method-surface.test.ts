// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 — one `String.prototype` method surface (`src/ir/string-method-surface.ts`)
// for the selector, the builder and both backends. Every row is claimed on
// both WasmGC lanes with a rope receiver (a concatenation of parameters) and
// is never withdrawn; each role's omitted value and literal folds answer as
// JavaScript does. On the linear backend a call it has no plan for is refused
// at selection.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { getLastLinearIrReport } from "../src/ir/backend/linear-integration.js";
import { buildImports } from "../src/runtime.js";
import { lane, TARGETS, type Target } from "./helpers/ambient-intrinsic-probe.js";

const PARAMETERS = "p: string, q: string, u: string, v: string, w: string, z: string";
const ARGUMENTS = '"ab", "cd", " a", "b ", "ab", "AB"';

/** node's answer for `expression` over the same strings. */
function expected(expression: string): string {
  const value = new Function(PARAMETERS.replace(/: string/g, ""), `return ${expression};`)(
    "ab",
    "cd",
    " a",
    "b ",
    "ab",
    "AB",
  );
  return JSON.stringify(value);
}

/**
 * One claimed function per expression, called with literals from `run()`: the
 * receivers `p + q`, `u + v`, … are ropes the compiler cannot fold. `run()`
 * answers how many expressions disagree with node.
 */
async function compileChecks(target: Target, expressions: readonly string[]) {
  const checks = expressions.map(
    (expression, i) =>
      `function check${i}(${PARAMETERS}): boolean { return ${expression} === ${expected(expression)}; }`,
  );
  const calls = expressions.map((_, i) => `(check${i}(${ARGUMENTS}) ? 0 : 1)`).join(" + ");
  const source = `${checks.join("\n")}\nexport function run(): number { return ${calls}; }`;
  const result = await compile(source, {
    fileName: "t.ts",
    skipSemanticDiagnostics: true,
    trackIrOutcomes: true,
    ...(target ? { target } : {}),
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  const imports = target ? {} : buildImports(result.imports, {}, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  const claimed = expressions.map(
    (_, i) => result.irOutcomes?.find((o) => o.displayName === `check${i}`)?.irBodyEmitted,
  );
  return { claimed, failures: (instance.exports.run as () => number)() };
}

const ROWS: Record<string, readonly string[]> = {
  toUpperCase: ["(p + q).toUpperCase()"],
  toLowerCase: ["(z + z).toLowerCase()"],
  toLocaleUpperCase: ["(p + q).toLocaleUpperCase()"],
  toLocaleLowerCase: ["(z + z).toLocaleLowerCase()"],
  trim: ["(u + v).trim()"],
  trimStart: ["(u + v).trimStart()"],
  trimEnd: ["(u + v).trimEnd()"],
  padStart: [
    '(p + q).padStart(6, "xy")',
    "(p + q).padStart(6)",
    "(p + q).padStart(6, undefined)",
    "(p + q).padStart()",
  ],
  padEnd: ['(p + q).padEnd(7, "xy")', "(p + q).padEnd(6)", "(p + q).padEnd(6, undefined)", "(p + q).padEnd(null)"],
  charAt: ["(p + q).charAt(2)", "(p + q).charAt()", "(p + q).charAt(true)"],
  charCodeAt: ["(p + q).charCodeAt(3)", "(p + q).charCodeAt()"],
  slice: ["(p + q).slice(1)", "(p + q).slice(1, 3)", "(p + q).slice(undefined, 2)"],
  substring: ["(p + q).substring()", "(p + q).substring(1)", "(p + q).substring(3, 1)"],
  indexOf: ['(p + q).indexOf("c")', '(p + q).indexOf("c", 3)', '(p + q).indexOf("a", null)'],
  lastIndexOf: [
    '(w + w).lastIndexOf("b")',
    '(w + w).lastIndexOf("b", 2)',
    '(w + w).lastIndexOf("b", NaN)',
    '(w + w).lastIndexOf("b", undefined)',
  ],
  includes: ['(p + q).includes("bc")', '(p + q).includes("a", 1)'],
  startsWith: ['(p + q).startsWith("ab")', '(p + q).startsWith("cd", 2)', '(p + q).startsWith("ab", true)'],
  endsWith: ['(p + q).endsWith("cd")', '(p + q).endsWith("ab", 2)', '(p + q).endsWith("cd", undefined)'],
};

describe("#7106 one string-method surface", () => {
  for (const target of TARGETS) {
    describe(lane(target), () => {
      for (const [method, expressions] of Object.entries(ROWS)) {
        it(`claims a rope receiver and answers as JavaScript: ${method}`, async () => {
          const { claimed, failures } = await compileChecks(target, expressions);
          expect(claimed).toEqual(expressions.map(() => true));
          expect(failures).toBe(0);
        });
      }
      it("a search argument that needs ToString stays legacy", async () => {
        const { claimed, failures } = await compileChecks(target, ['"a1b".includes(1)']);
        expect(claimed).toEqual([false]);
        expect(failures).toBe(0);
      });
      it("a shadowed `undefined` is a value, not the omitted argument", async () => {
        const source = `function check(p: string, q: string): string { const undefined = 2; return (p + q).charAt(undefined); }
export function run(): number { return check("ab", "cd") === "c" ? 1 : 0; }`;
        const result = await compile(source, {
          fileName: "t.ts",
          skipSemanticDiagnostics: true,
          trackIrOutcomes: true,
          ...(target ? { target } : {}),
        });
        expect(result.irOutcomes?.find((o) => o.displayName === "check")?.irBodyEmitted).toBe(true);
        const imports = target ? {} : buildImports(result.imports, {}, result.stringPool);
        const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
        expect((instance.exports.run as () => number)()).toBe(1);
      });
    });
  }

  it("the linear backend refuses at selection what its plan does not lower", async () => {
    const source = `export function upper(s: string): string { return s.toUpperCase(); }
export function code(s: string): number { return s.charCodeAt(0); }`;
    await compile(source, { fileName: "t.ts", target: "linear" });
    const report = getLastLinearIrReport();
    expect(report?.compiled).toEqual(["code"]);
    expect(report?.rejected).toEqual([{ func: "upper", reason: "select:string-method-unsupported" }]);
  });
});
