// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compile } from "../src/index.js";

// Import-free IR-overlay controls; complete-program source-global admission is separate.
for (const strict of [false, true]) {
  for (const valuePosition of [false, true]) {
    for (const [left, right, expected] of [
      [5, 2, 7],
      ["5", 2, "52"],
      [5, "2", "52"],
      ["5", "2", "52"],
      ["é", 2, "é2"],
      [5, "λ", "5λ"],
    ] as const) {
      it(`module ${JSON.stringify(left)} += ${JSON.stringify(right)}, ${strict ? "strict" : "sloppy"}, ${valuePosition ? "value" : "statement"}`, async () => {
        const result = await compile(
          `${strict ? '"use strict";' : ""}
var x; x = ${JSON.stringify(left)}; var calls = 0;
function rhs() { calls = calls + 1; x = "changed"; return ${JSON.stringify(right)}; }
${valuePosition ? "var y; y = (x += rhs());" : "x += rhs();"}
if (x !== ${JSON.stringify(expected)}) throw "stored result or old-value order";
${valuePosition ? `if (y !== ${JSON.stringify(expected)}) throw "returned result";` : ""}
if (calls !== 1) throw "RHS count";`,
          {
            fileName: "module-plus.js",
            allowJs: true,
            // Match Test262: valid JavaScript can intentionally mix operand types.
            skipSemanticDiagnostics: true,
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
}

for (const strict of [false, true]) {
  it(`preserves original compound result forms (${strict ? "strict" : "sloppy"})`, async () => {
    const result = await compile(
      `${strict ? '"use strict";' : ""}
var x = 1; var x1 = (x += 1);
var y; var y1; y = 1; y1 = (y += 1);
if (x !== 2 || x1 !== 2 || y !== 2 || y1 !== 2) throw "original result forms";`,
      {
        fileName: "module-plus-original-forms.js",
        allowJs: true,
        skipSemanticDiagnostics: true,
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

for (const strict of [false, true]) {
  for (const valuePosition of [false, true]) {
    it(`does not store after abrupt RHS (${strict}, ${valuePosition})`, async () => {
      const result = await compile(
        `${strict ? '"use strict";' : ""}
var x; x = 5; var y; y = "untouched"; var calls = 0; var caught = 0;
function rhs() { calls = calls + 1; x = 99; if (calls === 1) throw "stop"; return 2; }
try { ${valuePosition ? "y = (x += rhs());" : "x += rhs();"} }
catch (e) { if (e === "stop") caught = 1; }
if (x !== 99 || y !== "untouched" || calls !== 1 || caught !== 1) throw "abrupt order";`,
        {
          fileName: "module-plus-abrupt.js",
          allowJs: true,
          skipSemanticDiagnostics: true,
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

it("refuses initialized dynamic compound result into numeric global before claim", async () => {
  const result = await compile(
    `
var x; x = 5; var calls = 0;
function rhs() { calls = calls + 1; x = "changed"; return 2; }
var y = ((x += rhs()));
if (x !== 7 || y !== 7 || calls !== 1) throw "result";`,
    {
      fileName: "module-plus-incompatible-result.js",
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "standalone",
      trackIrOutcomes: true,
      deferTopLevelInit: true,
    },
  );
  expect(result.irPostClaimErrors).toEqual([]);
  const init = result.irOutcomes?.find((entry) => entry.displayName === "<module-init>");
  expect(init?.irBodyEmitted, JSON.stringify(init)).toBe(false);
  expect(init?.stage).toBe("select");
});
