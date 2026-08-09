// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadOriginalHarnessTests } from "../scripts/test262-fyi-reader.mjs";
import { hasModuleSyntax, isModuleGoal } from "../scripts/test262-module-goal.mjs";
import { compile } from "../src/index.js";
import { isModuleGoal as runnerModuleGoal, parseMeta } from "./test262-runner.js";

const typedArrayPaths = [
  "built-ins/TypedArray/prototype/slice/result-does-not-copy-ordinary-properties.js",
  "built-ins/TypedArray/prototype/subarray/result-does-not-copy-ordinary-properties.js",
] as const;

type OriginalHarnessRecord = Awaited<ReturnType<typeof loadOriginalHarnessTests>>[number];

describe("#3489 Test262 module-goal classification", () => {
  let literalRecords: OriginalHarnessRecord[];

  beforeAll(async () => {
    literalRecords = await loadOriginalHarnessTests([...typedArrayPaths]);
  });

  it("uses the shared classifier in both project callsites", () => {
    expect(runnerModuleGoal).toBe(isModuleGoal);

    const precompiler = readFileSync(join(import.meta.dirname, "..", "scripts", "precompile-tests.ts"), "utf8");
    expect(precompiler).toContain('import { isModuleGoal } from "./test262-module-goal.mjs";');
    expect(precompiler).toContain("const inferModuleStrictArguments = isModuleGoal(category, meta, source);");
  });

  it("keeps metadata and module-only path categories authoritative", () => {
    expect(isModuleGoal("built-ins/Array/plain.js", { flags: ["module"] }, "0;")).toBe(true);
    expect(isModuleGoal("built-ins/Array/plain.js", { module: true }, "0;")).toBe(true);
    expect(isModuleGoal("language/module-code", {}, "0;")).toBe(true);
    expect(isModuleGoal("language/import/import-empty.js", {}, "0;")).toBe(true);
    expect(isModuleGoal("test/language/export/export-empty.js", {}, "0;")).toBe(true);
    expect(isModuleGoal("/checkout/test262/test/language/module-code/plain.js", {}, "0;")).toBe(true);
  });

  it("uses AST syntax instead of import/export text", () => {
    const scripts = [
      "// import value from './fixture.js';\n0;",
      "/* export default 1; */\n0;",
      'const message = "does not import own property";',
      "const message = `export default value`;",
      "const matcher = /import|export/;",
      "const importValue = 1, exportValue = 2; ({ import: importValue, export: exportValue });",
      "import('./fixture.js');",
    ];

    for (const source of scripts) {
      expect(hasModuleSyntax(source), source).toBe(false);
      expect(isModuleGoal("language/expressions/dynamic-import/plain.js", {}, source), source).toBe(false);
    }
  });

  it("recognizes static imports, exports, and import.meta", () => {
    const modules = [
      "import './fixture.js';",
      "import value from './fixture.js';",
      "export {};",
      "export const value = 1;",
      "export default 1;",
      "import.meta.url;",
    ];

    for (const source of modules) {
      expect(hasModuleSyntax(source), source).toBe(true);
      expect(isModuleGoal("built-ins/Array/plain.js", {}, source), source).toBe(true);
    }
  });

  it("classifies both exact literal FYI assemblies as Script without rewriting declarations", () => {
    expect(literalRecords.map((record) => record.file).sort()).toEqual([...typedArrayPaths].sort());

    for (const record of literalRecords) {
      const rawSource = readFileSync(join(import.meta.dirname, "..", "test262", "test", record.file), "utf8");
      const meta = parseMeta(rawSource);

      expect(/\b(?:import|export)\b/.test(rawSource), record.file).toBe(true);
      expect(/\b(?:import|export)\b/.test(record.contents), record.file).toBe(true);
      expect(record.contents.split("function isPrimitive(")).toHaveLength(3);
      expect(isModuleGoal(record.file, meta, rawSource), record.file).toBe(false);
      expect(isModuleGoal(record.file, record.flags, record.contents), record.file).toBe(false);
      expect(isModuleGoal(record.file, record.flags, `"use strict";\n${record.contents}`), record.file).toBe(false);
    }
  });

  it("reproduces the duplicate identifier when a literal assembly is forced to Module goal", async () => {
    const record = literalRecords[0]!;
    const result = await compile(record.contents, {
      allowJs: true,
      fileName: record.file,
      skipSemanticDiagnostics: true,
      inferModuleStrictArguments: true,
    });

    expect(result.success).toBe(false);
    expect(result.errors.map((error) => error.message).join("; ")).toContain("Duplicate identifier 'isPrimitive'");
  });

  it("compiles both literal assemblies as Script in gc and standalone", async () => {
    for (const record of literalRecords) {
      for (const target of ["gc", "standalone"] as const) {
        for (const strict of [false, true]) {
          const source = `${strict ? '"use strict";\n' : ""}${record.contents}`;
          const result = await compile(source, {
            allowJs: true,
            fileName: record.file,
            skipSemanticDiagnostics: true,
            inferModuleStrictArguments: isModuleGoal(record.file, record.flags, source),
            ...(target === "standalone" ? { target } : {}),
          });
          const detail = result.errors.map((error) => error.message).join("; ");
          expect(result.success, `${target} ${record.file}${strict ? " [strict]" : ""}: ${detail}`).toBe(true);
        }
      }
    }
  }, 60_000);
});
