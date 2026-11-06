// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compile } from "../src/index.js";
import { compile as compilePrepared, requiredPreparedEmission } from "../src/test262/test262-prepared-entry.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";

// Runtime controls for emitted IR overlays, not complete-program Test262 qualification.
for (const strict of [false, true]) {
  for (const [op, expected] of [
    ["<<=", 10],
    ["^=", 4],
    ["%=", 0],
    ["-=", 4],
    ["*=", 5],
    ["/=", 5],
    ["|=", 5],
    ["&=", 1],
    [">>=", 2],
    [">>>=", 2],
  ] as const) {
    it(`returns and stores dynamic ${op} (${strict ? "strict" : "sloppy"})`, async () => {
      const result = await compile(
        `${strict ? '"use strict";' : ""}
var x; x = 5; var calls = 0;
function rhs() { calls = calls + 1; x = 100; return 1; }
var y = (x ${op} rhs());
if (x !== ${expected} || y !== ${expected} || calls !== 1) throw "compound value/order";`,
        {
          fileName: "compound-value.js",
          allowJs: true,
          target: "standalone",
          trackIrOutcomes: true,
          deferTopLevelInit: true,
        },
      );
      expect(result.success, JSON.stringify(result.errors)).toBe(true);
      expect(result.irPostClaimErrors).toEqual([]);
      const init = result.irOutcomes?.find((entry) => entry.displayName === "<module-init>");
      expect(init?.irBodyEmitted, JSON.stringify(init)).toBe(true);
      const module = await WebAssembly.compile(result.binary);
      expect(WebAssembly.Module.imports(module)).toEqual([]);
      const instance = await WebAssembly.instantiate(module, {});
      (instance.exports.__module_init as () => void)();
    });
  }
}

for (const [name, body, expected] of [
  ["numeric plus returns the stored value", "let x = 5; const y = (x += 2); return y * 100 + x;", 707],
  ["nested mutations capture each old value", "let x = 5; const y = (x *= (x -= 2)); return y * 100 + x;", 1515],
  ["unsigned result remains unsigned", "let x = -1; return x >>>= 0;", 4294967295],
  ["signed bitwise result", "let x = 2147483647; const y = (x <<= 1); return y * 100 + x;", -202],
  [
    "compound expression in loop body",
    "let x = 0; let y = 0; for (let i = 0; i < 3; i += 1) { y = (x += 2); } return y * 100 + x;",
    606,
  ],
] as const) {
  it(`runs required prepared IR: ${name}`, async () => {
    const result = await compilePrepared(`export function main(): number { ${body} }`, {
      fileName: "entry.ts",
      target: "standalone",
      backend: "wasmgc",
      sourceMap: false,
      wholeProgram: { kind: "prepared-program-required", version: 1 },
    });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(requiredPreparedEmission(result)).toBeDefined();
    expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
    const { instance } = instantiatePreparedArtifact(result);
    expect((instance.exports.main as () => number)()).toBe(expected);
  });
}

it("does not admit dynamic exponentiation as a compound value", async () => {
  const result = await compile("var x; x = 2; var y = (x **= 3);", {
    fileName: "compound-power.js",
    allowJs: true,
    target: "standalone",
    trackIrOutcomes: true,
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  expect(result.irPostClaimErrors).toEqual([]);
  const init = result.irOutcomes?.find((entry) => entry.displayName === "<module-init>");
  expect(init).toBeDefined();
  expect(init?.irBodyEmitted).toBe(false);
});

for (const [name, mutation, checks] of [
  ["dynamic", "var y = (m += 2);", "if (m !== 7) return; if (y !== 7) return;"],
  ["string", 'var s = "a"; var y = (s += "b");', 'if (s !== "ab") return; if (y !== "ab") return;'],
] as const) {
  it(`returns and stores ${name} local += in a planned closure`, async () => {
    const result = await compile(
      `/** @returns {number} */ function subject() { return 0; }
subject.f = function(m, k) { if (k === 9) return; ${mutation} ${checks} throw m; };
export function run() { var n = 0; try { subject.f(5, 0); } catch(e) { if (e === ${name === "dynamic" ? 7 : 5}) n += 1; } return n; }`,
      {
        fileName: "local-plus.js",
        allowJs: true,
        target: "standalone",
        trackIrOutcomes: true,
        deferTopLevelInit: true,
      },
    );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(result.irPostClaimErrors).toEqual([]);
    const init = result.irOutcomes?.find((entry) => entry.displayName === "<module-init>");
    expect(init?.irBodyEmitted, JSON.stringify(init)).toBe(true);
    const module = await WebAssembly.compile(result.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    (instance.exports.__module_init as () => void)();
    expect((instance.exports.run as () => number)()).toBe(1);
  });
}

it("judges a numeric compound result as a number, not its dynamic slot", async () => {
  const result = await compile(
    `/** @returns {number} */ function subject() { return 0; }
subject.f = function(m, k) { if(k === 9) return; var y = (m -= 2); if(y === "3") return; throw m; };
export function run() { var n = 0; try { subject.f(5, 0); } catch(e) { if(e === 3) n += 1; } return n; }`,
    {
      fileName: "numeric-compound-proof.js",
      allowJs: true,
      target: "standalone",
      trackIrOutcomes: true,
    },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  expect(result.irPostClaimErrors).toEqual([]);
  const init = result.irOutcomes?.find((entry) => entry.displayName === "<module-init>");
  // Mixed number/string equality still has no lowering; it must refuse before claim.
  expect(init?.stage).toBe("select");
  expect(init?.irBodyEmitted).toBe(false);
});
