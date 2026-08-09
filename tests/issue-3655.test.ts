// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3655 — compile-time static CommonJS JSON modules in compileProject graphs.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compileProject, ModuleResolver, resolveAllImports } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { ESLINT_DEV_DEPENDENCY_SKIP, requireEslintFile, resolveEslintFile } from "./helpers/eslint.js";

let fixtureRoot: string;
const ESLINT_LINTER = resolveEslintFile("lib/linter/linter.js");

function write(path: string, source: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
}

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "js2wasm-3655-"));
  write(
    join(fixtureRoot, "package.json"),
    JSON.stringify({
      name: "json-fixture",
      version: "1.2.3",
      enabled: true,
      absent: null,
      nested: { count: 3 },
      values: ["zero", 2, false, null],
    }),
  );
  write(
    join(fixtureRoot, "entry.js"),
    [
      'const pkg = require("./package.json");',
      "export function verifyJsonValue() {",
      "  return pkg.name === 'json-fixture' &&",
      "    pkg.version === '1.2.3' &&",
      "    pkg.enabled === true &&",
      "    pkg.absent === null &&",
      "    pkg.nested.count === 3 &&",
      "    pkg.values[0] === 'zero' &&",
      "    pkg.values[1] === 2 &&",
      "    pkg.values[2] === false &&",
      "    pkg.values[3] === null ? 1 : 0;",
      "}",
      "",
    ].join("\n"),
  );
  write(join(fixtureRoot, "missing.js"), 'const value = require("./missing.json");\nexport default value;\n');
  write(join(fixtureRoot, "malformed.json"), '{"name": "broken", }\n');
  write(join(fixtureRoot, "malformed.js"), 'const value = require("./malformed.json");\nexport default value;\n');
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("#3655 — static CommonJS JSON modules", () => {
  it("materializes nested JSON values with their JavaScript types", async () => {
    const result = await compileProject(join(fixtureRoot, "entry.js"), {
      allowJs: true,
      target: "gc",
      platform: "node",
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    if (!result.success) return;

    const wasmImports = WebAssembly.Module.imports(new WebAssembly.Module(result.binary));
    expect(wasmImports.some((entry) => entry.name === "__node_fs")).toBe(false);
    const imports = buildImports(result.imports as never, undefined, result.stringPool);
    const instance = await WebAssembly.instantiate(result.binary, imports as never);
    if (typeof (imports as { setExports?: (exports: WebAssembly.Exports) => void }).setExports === "function") {
      (imports as { setExports: (exports: WebAssembly.Exports) => void }).setExports(instance.instance.exports);
    }
    expect((instance.instance.exports.verifyJsonValue as () => number)()).toBe(1);
  });

  it("reports a missing JSON file with importer, specifier, and resolved path", async () => {
    const entry = join(fixtureRoot, "missing.js");
    const result = await compileProject(entry, { allowJs: true });
    expect(result.success).toBe(false);
    const diagnostics = result.errors.map((error) => error.message).join("\n");
    expect(diagnostics).toContain(entry);
    expect(diagnostics).toContain("./missing.json");
    expect(diagnostics).toContain(join(fixtureRoot, "missing.json"));
    expect(diagnostics).toContain("file not found");
  });

  it("reports malformed JSON with importer, JSON path, and parse detail", async () => {
    const entry = join(fixtureRoot, "malformed.js");
    const json = join(fixtureRoot, "malformed.json");
    const result = await compileProject(entry, { allowJs: true });
    expect(result.success).toBe(false);
    const diagnostics = result.errors.map((error) => error.message).join("\n");
    expect(diagnostics).toContain(entry);
    expect(diagnostics).toContain(json);
    expect(diagnostics).toContain("could not parse");
  });

  it.skipIf(ESLINT_LINTER === null)(
    `includes ESLint's package.json as a compile-time graph module ${ESLINT_DEV_DEPENDENCY_SKIP}`,
    () => {
      const entry = requireEslintFile(ESLINT_LINTER, "lib/linter/linter.js");
      const resolver = new ModuleResolver(dirname(entry), { allowJs: true, platform: "node" });
      const resolved = resolver.resolve("../../package.json", entry);
      expect(resolved).toMatch(/eslint[/\\]package\.json$/);
      const graph = resolveAllImports(entry, resolver);
      expect(Array.from(graph.keys())).toContain(resolved);
      expect(resolver.getDiagnostics()).toEqual([]);
    },
  );
});
