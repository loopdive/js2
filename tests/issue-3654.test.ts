// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3654 — package-resolution context for ESLint-shaped pnpm/CommonJS graphs.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compileProject, ModuleResolver, resolveAllImports } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { ESLINT_DEV_DEPENDENCY_SKIP, requireEslintFile, resolveEslintFile } from "./helpers/eslint.js";

let fixtureRoot: string;
let logicalEntry: string;
let physicalApp: string;
let physicalDep: string;
let physicalTypes: string;
const ESLINT_LINTER = resolveEslintFile("lib/linter/linter.js");

function write(path: string, source: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
}

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "js2wasm-3654-"));
  physicalApp = join(fixtureRoot, ".pnpm/app@1.0.0/node_modules/app");
  physicalDep = join(fixtureRoot, ".pnpm/dep@1.0.0/node_modules/dep");
  physicalTypes = join(fixtureRoot, ".pnpm/types-only@1.0.0/node_modules/types-only");

  write(join(physicalApp, "package.json"), JSON.stringify({ name: "app", main: "lib/entry.js" }));
  write(
    join(physicalApp, "lib/entry.js"),
    [
      'const dep = require("dep"),',
      '  helper = require("./helper"),',
      '  directory = require("./directory");',
      "const importText = 'import(\"ghost-json-string\")';",
      "export function answer() {",
      "  return dep.answer() + helper() + directory();",
      "}",
      "",
    ].join("\n"),
  );
  write(join(physicalApp, "lib/helper.js"), "module.exports = function helper() { return 1; };\n");
  write(join(physicalApp, "lib/directory/index.js"), "module.exports = function directory() { return 1; };\n");
  write(
    join(physicalApp, "lib/types-entry.ts"),
    'import type { Marker } from "types-only";\nexport type AppMarker = Marker;\n',
  );
  write(
    join(physicalApp, "lib/node-entry.js"),
    [
      'const path = require("node:path");',
      "export function isExpectedBasename() {",
      '  return path.basename("/tmp/eslint.js") === "eslint.js" ? 1 : 0;',
      "}",
      "",
    ].join("\n"),
  );

  write(join(physicalDep, "package.json"), JSON.stringify({ name: "dep", main: "index.js" }));
  write(join(physicalDep, "index.js"), "module.exports = { answer() { return 40; } };\n");

  write(
    join(physicalTypes, "package.json"),
    JSON.stringify({
      name: "types-only",
      type: "module",
      types: "./dist/esm/types.d.ts",
      exports: {
        types: {
          import: "./dist/esm/types.d.ts",
          require: "./dist/cjs/types.d.cts",
        },
      },
    }),
  );
  write(join(physicalTypes, "dist/esm/types.d.ts"), "export interface Marker { readonly kind: 'marker'; }\n");
  write(join(physicalTypes, "dist/cjs/types.d.cts"), "export interface Marker { readonly kind: 'marker'; }\n");

  mkdirSync(join(physicalApp, "node_modules"), { recursive: true });
  symlinkSync(physicalDep, join(physicalApp, "node_modules/dep"), "dir");
  symlinkSync(physicalTypes, join(physicalApp, "node_modules/types-only"), "dir");
  mkdirSync(join(fixtureRoot, "node_modules"), { recursive: true });
  symlinkSync(physicalApp, join(fixtureRoot, "node_modules/app"), "dir");

  logicalEntry = join(fixtureRoot, "node_modules/app/lib/entry.js");
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("#3654 — importer-scoped pnpm/CommonJS resolution", () => {
  it.skipIf(ESLINT_LINTER === null)(
    `resolves the real ESLint package, relative, directory, and type-only edges ${ESLINT_DEV_DEPENDENCY_SKIP}`,
    () => {
      const entry = requireEslintFile(ESLINT_LINTER, "lib/linter/linter.js");
      const resolver = new ModuleResolver(dirname(entry), { allowJs: true, platform: "node" });
      const expectedRuntimeSpecifiers = [
        "eslint-scope",
        "eslint-visitor-keys",
        "@eslint/plugin-kit",
        "debug",
        "../shared/traverser",
        "../languages/js/source-code",
        "./apply-disable-directives",
        "./source-code-fixer",
        "./source-code-visitor",
        "./timing",
      ];
      for (const specifier of expectedRuntimeSpecifiers) {
        expect(resolver.resolve(specifier, entry), specifier).toMatch(/\.[cm]?js$/);
      }
      expect(resolver.resolve("@eslint/core", entry)).toMatch(/types\.d\.[cm]?ts$/);
      expect(resolver.resolve("../types", entry)).toMatch(/types[/\\]index\.d\.ts$/);
      expect(resolver.resolve("node:path", entry)).toBeNull();
      expect(resolver.resolve("../../package.json", entry)).toMatch(/eslint[/\\]package\.json$/);

      const graphPaths = Array.from(resolveAllImports(entry, resolver).keys());
      expect(new Set(graphPaths.map((path) => realpathSync(path))).size).toBe(graphPaths.length);
    },
  );

  it("uses the physical importer context and keeps one canonical module identity", () => {
    const resolver = new ModuleResolver(dirname(logicalEntry), { allowJs: true });
    const dep = resolver.resolve("dep", logicalEntry);

    expect(dep).toBe(realpathSync(join(physicalDep, "index.js")));

    const graph = resolveAllImports(logicalEntry, resolver);
    const paths = Array.from(graph.keys());
    expect(paths).toContain(realpathSync(logicalEntry));
    expect(paths).toContain(realpathSync(join(physicalDep, "index.js")));
    expect(paths).toContain(realpathSync(join(physicalApp, "lib/helper.js")));
    expect(paths).toContain(realpathSync(join(physicalApp, "lib/directory/index.js")));
    expect(new Set(paths.map((path) => realpathSync(path))).size).toBe(paths.length);
    expect(resolver.getResolvedImports(logicalEntry).has("ghost-json-string")).toBe(false);
  });

  it("keeps a conditional types-only package as declarations instead of inventing a runtime body", () => {
    const entry = join(fixtureRoot, "node_modules/app/lib/types-entry.ts");
    const resolver = new ModuleResolver(dirname(entry), { allowJs: true });
    const resolved = resolver.resolve("types-only", entry);

    expect(resolved).toMatch(/types-only[/\\]dist[/\\]esm[/\\]types\.d\.ts$/);
    const graphPaths = Array.from(resolveAllImports(entry, resolver).keys());
    expect(graphPaths).toContain(realpathSync(join(physicalTypes, "dist/esm/types.d.ts")));
    expect(graphPaths.some((path) => /types-only[/\\].*\.[cm]?js$/.test(path))).toBe(false);
  });

  it("threads the resolved pnpm edges into compileProject's virtual checker", async () => {
    const result = await compileProject(logicalEntry, { allowJs: true, target: "gc", platform: "node" });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    if (!result.success) return;
    expect(WebAssembly.validate(result.binary)).toBe(true);
  });

  it("passes node:path through to the real Node module in the JS-host lane", async () => {
    const entry = join(fixtureRoot, "node_modules/app/lib/node-entry.js");
    const result = await compileProject(entry, { allowJs: true, target: "gc", platform: "node" });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    if (!result.success) return;

    expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toContainEqual({
      module: "env",
      name: "__node_path",
      kind: "function",
    });
    const imports = buildImports(result.imports as never, undefined, result.stringPool);
    const instance = await WebAssembly.instantiate(result.binary, imports as never);
    if (typeof (imports as { setExports?: (exports: WebAssembly.Exports) => void }).setExports === "function") {
      (imports as { setExports: (exports: WebAssembly.Exports) => void }).setExports(instance.instance.exports);
    }
    expect((instance.instance.exports.isExpectedBasename as () => number)()).toBe(1);
  });
});
