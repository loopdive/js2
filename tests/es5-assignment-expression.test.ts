// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compile } from "../src/test262/test262-prepared-entry.js";
import { compile as compileOverlay } from "../src/index.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";

for (const strict of [false, true]) {
  for (const [name, body, expected] of [
    ["return", "let x = 0; return (x = 7);", 7],
    ["arithmetic", "let x = 0; return (x = 7) + x;", 14],
    ["chain", "let x = 0; let y = 0; return (x = y = 7) + x + y;", 21],
    ["conditional", "let x = false; return (x = true) ? 7 : 0;", 7],
    ["negative zero", "let x = 1; return 1 / (x = -0);", -Infinity],
    ["nested order", "let x = 0; return (x = (x = 9) + 1) + x;", 20],
    ["boolean", "let x = false; let y = (x = true); if (!y) return 0; return x ? 1 : 0;", 1],
    ["signed promoted result", "let x = 0; return (x = (-1 | 0)) + x;", -2],
    ["unsigned result", "let x = 0; return (x = (4294967295 >>> 0)) + x;", 8589934590],
    ["loop assignment result", "let sum = 0; for (let i = 0; i < 3;) sum = sum + (i = i + 1); return sum;", 6],
  ] as const) {
    it(`prepared assignment ${name} (${strict ? "explicit strict directive" : "module strictness"})`, async () => {
      const result = await compile(`${strict ? '"use strict";' : ""} export function run(): number { ${body} }`, {
        target: "standalone",
        wholeProgram: { kind: "prepared-program-required", version: 1 },
        sourceMap: false,
        optimize: false,
      });
      expect(result.success, JSON.stringify(result.errors)).toBe(true);
      const execution = instantiatePreparedArtifact(result);
      expect((execution.instance.exports.run as () => number)()).toBe(expected);
    });
  }
}

for (const strict of [false, true]) {
  for (const value of [7, "éλ", true]) {
    it(`dynamic module assignment returns concrete RHS (${strict}, ${JSON.stringify(value)})`, async () => {
      const literal = JSON.stringify(value);
      const result = await compileOverlay(
        `${strict ? '"use strict";' : ""}
var x; var y;
if ((y = (x = ${literal})) !== ${literal}) throw "returned";
if (x !== ${literal} || y !== ${literal}) throw "stored";`,
        {
          fileName: "assignment-value.js",
          allowJs: true,
          skipSemanticDiagnostics: true,
          target: "standalone",
          trackIrOutcomes: true,
          deferTopLevelInit: true,
        },
      );
      expect(result.success, JSON.stringify(result.errors)).toBe(true);
      expect(result.irPostClaimErrors).toEqual([]);
      const init = result.irOutcomes?.find((row) => row.displayName === "<module-init>");
      expect(init?.irBodyEmitted, JSON.stringify(init)).toBe(true);
      const module = await WebAssembly.compile(result.binary);
      expect(WebAssembly.Module.imports(module)).toEqual([]);
      const instance = await WebAssembly.instantiate(module, {});
      (instance.exports.__module_init as () => void)();
    });
  }
}

for (const [name, body, code] of [
  ["string", 'let x = "old"; return (x = "new") === "new" ? 1 : 0;', "body-shape-rejected"],
  ["any", "let x: any = 0; return (x = 7) + 1;", "unboxed-number-local-unprovable"],
] as const) {
  it(`keeps existing prepared ${name} storage boundary explicit`, async () => {
    const result = await compile(`export function run(): number { ${body} }`, {
      target: "standalone",
      wholeProgram: { kind: "prepared-program-required", version: 1 },
      sourceMap: false,
      optimize: false,
    });
    expect(result.success).toBe(false);
    expect(result.errors.some((error) => error.code === code)).toBe(true);
  });
}

for (const strict of [false, true]) {
  for (const abrupt of [false, true]) {
    it(`${abrupt ? "overlay abrupt" : "prepared normal"} RHS once and completion (${strict})`, async () => {
      const result = await (abrupt ? compileOverlay : compile)(
        `${strict ? '"use strict";' : ""}
let calls = 0; let target = 3;
function rhs(): number { calls = calls + 1; target = 9; ${abrupt ? 'if (calls === 1) throw "stop";' : ""} return 7; }
export function run(): number {
  let outer = 5; let caught = 0;
  try { outer = (target = rhs()); } catch (e) { caught = 1; }
  if (calls !== 1) return 0;
  if (target !== ${abrupt ? 9 : 7}) return 0;
  if (outer !== ${abrupt ? 5 : 7}) return 0;
  return caught === ${abrupt ? 1 : 0} ? 1 : 0;
}`,
        {
          target: "standalone",
          ...(abrupt
            ? { trackIrOutcomes: true }
            : { wholeProgram: { kind: "prepared-program-required" as const, version: 1 as const } }),
          sourceMap: false,
          optimize: false,
        },
      );
      expect(result.success, JSON.stringify(result.errors)).toBe(true);
      if (abrupt) {
        expect(result.irPostClaimErrors).toEqual([]);
        for (const name of ["run", "rhs"])
          expect(
            result.irOutcomes?.find((row) => row.displayName === name)?.irBodyEmitted,
            JSON.stringify(result.irOutcomes),
          ).toBe(true);
        const module = await WebAssembly.compile(result.binary);
        expect(WebAssembly.Module.imports(module)).toEqual([]);
        const instance = await WebAssembly.instantiate(module, {});
        expect((instance.exports.run as () => number)()).toBe(1);
      } else {
        const execution = instantiatePreparedArtifact(result);
        expect((execution.instance.exports.run as () => number)()).toBe(1);
      }
    });
  }
}

for (const [rhs, expected] of [
  ["7", "7"],
  ['"éλ"', '"éλ"'],
  ["true", "true"],
  ["m", "2"],
]) {
  it(`planned dynamic local assignment returns RHS family: ${rhs}`, async () => {
    const result = await compileOverlay(
      `/** @returns {number} */ function subject() { return 0; }
subject.f = function(m, k) { if (k === 9) return; var original = m; var y = (m = ${rhs});
if (y !== ${expected}) throw "bad"; if (m !== ${expected}) throw "bad"; throw original; };
export function run() { var n = 0; try { subject.f(2, 0); } catch(e) { if (e === 2) n = n + 1; } return n; }`,
      {
        fileName: "assignment-planned.js",
        allowJs: true,
        skipSemanticDiagnostics: true,
        target: "standalone",
        trackIrOutcomes: true,
      },
    );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(result.irPostClaimErrors).toEqual([]);
    const init = result.irOutcomes?.find((row) => row.displayName === "<module-init>");
    expect(init?.irBodyEmitted, JSON.stringify(init)).toBe(true);
    const module = await WebAssembly.compile(result.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    expect((instance.exports.run as () => number)()).toBe(1);
  });
}

for (const count of [2, 3]) {
  it(`overlay string chain stores all ${count} targets`, async () => {
    const result = await compileOverlay(
      `export function run(): number {
let a = ""; let b = ""; ${count === 3 ? 'let c = "";' : ""}
a = b = ${count === 3 ? "c = " : ""}"z";
return a + b ${count === 3 ? "+ c" : ""} === "${"z".repeat(count)}" ? 1 : 0;
}`,
      { target: "standalone", trackIrOutcomes: true },
    );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(result.irPostClaimErrors).toEqual([]);
    const run = result.irOutcomes?.find((row) => row.displayName === "run");
    expect(run?.irBodyEmitted, JSON.stringify(run)).toBe(true);
    const module = await WebAssembly.compile(result.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    expect((instance.exports.run as () => number)()).toBe(1);
  });
}

for (const prepared of [false, true]) {
  for (const [comparison, expected] of [
    ["2 < 3", 1],
    ["3 < 2", 0],
  ] as const) {
    it(`promoted assignment preserves Boolean RHS (${prepared ? "prepared" : "overlay"}, ${comparison})`, async () => {
      const source = `export function run(): boolean { let x = 1 < 2; return (x = ${comparison}); }`;
      const result = prepared
        ? await compile(source, {
            target: "standalone",
            optimize: false,
            wholeProgram: { kind: "prepared-program-required", version: 1 },
          })
        : await compileOverlay(source, { target: "standalone", optimize: false, trackIrOutcomes: true });
      expect(result.success, JSON.stringify(result.errors)).toBe(true);
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      if (!prepared) expect(result.irOutcomes?.find((row) => row.displayName === "run")?.irBodyEmitted).toBe(true);
      const module = await WebAssembly.compile(result.binary);
      expect(WebAssembly.Module.imports(module)).toEqual([]);
      const instance = await WebAssembly.instantiate(module, {});
      expect((instance.exports.run as () => number)()).toBe(expected);
    });
  }
}
