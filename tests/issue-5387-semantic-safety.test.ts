// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile, compileMulti, type CompileResult } from "../src/index.js";
import { compileSourceSync } from "../src/compiler.js";

const unsafe = 'const value:any="x";\nconst n:number=value; console.log(n+1);';
function expectRefusal(result: CompileResult, file: string, line: number) {
  expect(result.success).toBe(false);
  expect(result.binary.length).toBe(0);
  expect(result.errors).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        severity: "error",
        file,
        line,
        column: expect.any(Number),
        message: expect.stringContaining("[JS2WASM_UNSOUND_"),
      }),
    ]),
  );
}

describe("#5387 — public semantic safety diagnostics", () => {
  it.each([{}, { skipSemanticDiagnostics: true }, { allowJs: true, safe: false }])(
    "refuses unsafe origins with options %j",
    async (options) => {
      expectRefusal(await compile(unsafe, { ...options, fileName: "unsafe.ts" }), "unsafe.ts", 2);
    },
  );
  it("covers the synchronous compiler", () => {
    expectRefusal(compileSourceSync(unsafe, { fileName: "sync.ts" }), "sync.ts", 2);
  });
  it("anchors a dependency diagnostic to its own source", async () => {
    const result = await compileMulti(
      {
        "main.ts": 'import { n } from "./dep"; console.log(n+1);',
        "dep.ts": 'const value:any="x";\nexport const n:number=value;',
      },
      "main.ts",
      { skipSemanticDiagnostics: true },
    );
    expectRefusal(result, "dep.ts", 2);
  });
  it("maps diagnostic columns through define expansion", async () => {
    const source = 'const padding=BUILD; const n="x" as unknown as number; console.log(n+1);';
    const result = await compile(source, { fileName: "mapped.ts", define: { BUILD: '"a much longer replacement"' } });
    expectRefusal(result, "mapped.ts", 1);
    expect(result.errors.find((error) => error.message.includes("JS2WASM_UNSOUND_ASSERTION"))?.column).toBe(
      source.indexOf('"x"') + 1,
    );
  });
  it("keeps the preceding conditional alias repair accepted", async () => {
    const result = await compile('const a={x:1}; const b=true?a:{x:""}; b.x="x"; console.log(a.x+1);', {
      fileName: "alias.js",
      allowJs: true,
    });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
  });
});
