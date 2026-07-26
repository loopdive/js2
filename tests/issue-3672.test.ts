// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3672 — keep checker-only project roots out of multi-module codegen.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { COMPILE_PROFILE_MARKER } from "../src/compile-profile.js";
import { compileMulti, compileProject, type CompileResult } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { resolveEslintFile } from "./helpers/eslint.js";

let fixtureRoot: string;

function resolveEsqueryEsm(): string | null {
  const eslintLinter = resolveEslintFile("lib/linter/linter.js");
  if (eslintLinter === null) return null;
  try {
    const requireFromEslint = createRequire(realpathSync(eslintLinter));
    return join(dirname(requireFromEslint.resolve("esquery")), "esquery.esm.min.js");
  } catch {
    return null;
  }
}

const ESQUERY_ESM = resolveEsqueryEsm();

function write(path: string, source: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
}

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "js2wasm-3672-"));
  write(
    join(fixtureRoot, "entry.js"),
    [
      "/** @import { Marker } from './types' */",
      "import runtime from './runtime.js';",
      "export function answer() { return runtime(); }",
      "",
    ].join("\n"),
  );
  write(join(fixtureRoot, "runtime.js"), "export default function runtime() { return 42; }\n");
  write(
    join(fixtureRoot, "types.d.ts"),
    [
      "export interface Marker { readonly kind: 'marker'; }",
      "export { unreachable } from './checker-only.js';",
      "",
    ].join("\n"),
  );
  write(
    join(fixtureRoot, "checker-only.js"),
    ["export function unreachable(value) {", "  const { field } = value;", "  return field;", "}", ""].join("\n"),
  );
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("#3672 — project codegen reachability", () => {
  it("keeps conditional branch globals shift-visible while compiling its sibling", async () => {
    const result = await compileMulti(
      {
        "entry.ts": [
          "function invoke(cb: (value: number) => number, takeCallback: boolean): number | string {",
          '  return takeCallback ? cb(1) : "late-branch-string";',
          "}",
          "export function test(): number {",
          "  const value = invoke((n) => n + 1, true);",
          '  return typeof value === "number" ? value : -1;',
          "}",
        ].join("\n"),
      },
      "entry.ts",
      { target: "gc", platform: "node" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    if (!result.success) return;

    const imports = buildImports(result.imports as never, undefined, result.stringPool);
    const instance = await WebAssembly.instantiate(result.binary, imports as never);
    if (typeof (imports as { setExports?: (exports: WebAssembly.Exports) => void }).setExports === "function") {
      (imports as { setExports: (exports: WebAssembly.Exports) => void }).setExports(instance.instance.exports);
    }
    expect((instance.instance.exports.test as () => number)()).toBe(2);
  });

  it("does not strand dynamic in-operator keys when struct field strings are absent", async () => {
    const result = await compileMulti(
      {
        "entry.ts": [
          "const Strategies = { overwrite: 1, replace: 2 };",
          "function isMissing(key: string): boolean {",
          "  return !(key in Strategies);",
          "}",
          'export function test(): boolean { return isMissing("missing"); }',
        ].join("\n"),
      },
      "entry.ts",
      { target: "gc", platform: "node" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    if (!result.success) return;

    const imports = buildImports(result.imports as never, undefined, result.stringPool);
    const instance = await WebAssembly.instantiate(result.binary, imports as never);
    if (typeof (imports as { setExports?: (exports: WebAssembly.Exports) => void }).setExports === "function") {
      (imports as { setExports: (exports: WebAssembly.Exports) => void }).setExports(instance.instance.exports);
    }
    expect((instance.instance.exports.test as () => number)()).toBe(1);
  });

  it("keeps logical-condition temporaries type-correct after local compaction", async () => {
    const result = await compileMulti(
      {
        "entry.js": [
          "const MergeStrategy = { overwrite() {} };",
          "function validateDefinition(name, definition) {",
          "  let hasSchema = false;",
          "  if (definition.schema) {",
          '    if (typeof definition.schema === "object") hasSchema = true;',
          "  }",
          '  if (typeof definition.merge === "string") {',
          "    if (!(definition.merge in MergeStrategy)) return 1;",
          '  } else if (!hasSchema && typeof definition.merge !== "function") {',
          "    return 2;",
          "  }",
          '  if (typeof definition.validate === "string") {',
          "    return 3;",
          '  } else if (!hasSchema && typeof definition.validate !== "function") {',
          "    return 4;",
          "  }",
          "  return 0;",
          "}",
          "export function test() {",
          "  return validateDefinition('value', { merge() {}, validate() {} });",
          "}",
        ].join("\n"),
      },
      "entry.js",
      { allowJs: true, target: "gc", platform: "node" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    if (!result.success) return;

    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
  });

  it("keeps an inlined IIFE's var bindings local when names collide with module globals", async () => {
    const result = await compileMulti(
      {
        "entry.js": [
          "var result = 0;",
          "function collect(value) {",
          "  return (function (value) {",
          "    var result = [];",
          "    result.push(value);",
          "    return result;",
          "  })(value);",
          "}",
          "export function test() { return collect(41)[0]; }",
        ].join("\n"),
      },
      "entry.js",
      { allowJs: true, target: "gc", platform: "node" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    if (!result.success) return;
    expect(WebAssembly.validate(result.binary)).toBe(true);

    const imports = buildImports(result.imports as never, undefined, result.stringPool);
    const instance = await WebAssembly.instantiate(result.binary, imports as never);
    if (typeof (imports as { setExports?: (exports: WebAssembly.Exports) => void }).setExports === "function") {
      (imports as { setExports: (exports: WebAssembly.Exports) => void }).setExports(instance.instance.exports);
    }
    expect((instance.instance.exports.test as () => number)()).toBe(41);
  });

  it("reserves nested function identities before compiling a lifted closure body", async () => {
    const result = await compileMulti(
      {
        "entry.js": [
          'import "./numeric-m.js";',
          'import "./function-m.js";',
          "export function test() {",
          "  const run = function () {",
          "    function m(value) { return value + 1; }",
          "    return m(41);",
          "  };",
          "  return run();",
          "}",
        ].join("\n"),
        "numeric-m.js": "export var m = 60000;\n",
        "function-m.js": "export function m() { return -1; }\n",
      },
      "entry.js",
      { allowJs: true, target: "gc", platform: "node" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    if (!result.success) return;
    expect(WebAssembly.validate(result.binary)).toBe(true);

    const imports = buildImports(result.imports as never, undefined, result.stringPool);
    const instance = await WebAssembly.instantiate(result.binary, imports as never);
    if (typeof (imports as { setExports?: (exports: WebAssembly.Exports) => void }).setExports === "function") {
      (imports as { setExports: (exports: WebAssembly.Exports) => void }).setExports(instance.instance.exports);
    }
    expect((instance.instance.exports.test as () => number)()).toBe(42);
  });

  it("resolves a closure call to its declaration after both function and numeric-global collisions", async () => {
    const result = await compileMulti(
      {
        "entry.js": [
          'import "./numeric-m.js";',
          'import "./occupying-m.js";',
          'import { buildMatcher } from "./matcher.js";',
          "export function test() {",
          "  const matcher = buildMatcher();",
          "  return matcher({}, [], {}) ? 1 : 0;",
          "}",
        ].join("\n"),
        "numeric-m.js": "var s = 1000; var m = s * 60; module.exports = m;\n",
        "occupying-m.js": ["export function m() { return -1; }", "m = function () { return -2; };", ""].join("\n"),
        "matcher.js": [
          "function m(node, ancestry, nth, options) { return nth === 1; }",
          "export function buildMatcher() {",
          "  var C = 1;",
          "  var P = function () { return true; };",
          "  return function (e, t, r) { return P(e, t, r) && m(e, t, C, r); };",
          "}",
        ].join("\n"),
      },
      "entry.js",
      { allowJs: true, target: "gc", platform: "node" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    if (!result.success) return;
    expect(WebAssembly.validate(result.binary)).toBe(true);
  });

  it.skipIf(ESQUERY_ESM === null)(
    "does not route minified esquery helpers through same-named globals from another module",
    async () => {
      const collisionRoot = join(fixtureRoot, "esquery-collision");
      write(
        join(collisionRoot, "numeric-m.js"),
        ["var second = 1000;", "var m = second * 60;", "module.exports = m;", ""].join("\n"),
      );
      write(
        join(collisionRoot, "entry.js"),
        [
          'import "./numeric-m.js";',
          `import esquery from ${JSON.stringify(ESQUERY_ESM)};`,
          'export function test() { return typeof esquery === "function" ? 1 : 0; }',
          "",
        ].join("\n"),
      );

      const result = await compileProject(join(collisionRoot, "entry.js"), {
        allowJs: true,
        target: "gc",
        platform: "node",
        deferTopLevelInit: true,
      });
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      if (!result.success) return;
      expect(WebAssembly.validate(result.binary)).toBe(true);
    },
  );

  it("keeps same-named file-local helpers declaration-scoped", async () => {
    const result = await compileMulti(
      {
        "entry.ts": [
          'import { runA } from "./a.js";',
          'import { runB } from "./b.js";',
          "export function test(): number { return runA() * 10 + runB(); }",
        ].join("\n"),
        "a.ts": [
          "function validate(value: number): number { return value + 1; }",
          "export function runA(): number { return validate(1); }",
        ].join("\n"),
        "b.ts": [
          "function validate(left: number, right: number): boolean { return left === right; }",
          "export function runB(): number { return validate(3, 3) ? 3 : 0; }",
        ].join("\n"),
      },
      "entry.ts",
      { target: "gc", platform: "node" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    if (!result.success) return;

    const imports = buildImports(result.imports as never, undefined, result.stringPool);
    const instance = await WebAssembly.instantiate(result.binary, imports as never);
    if (typeof (imports as { setExports?: (exports: WebAssembly.Exports) => void }).setExports === "function") {
      (imports as { setExports: (exports: WebAssembly.Exports) => void }).setExports(instance.instance.exports);
    }
    expect((instance.instance.exports.test as () => number)()).toBe(23);
  });

  it("resolves object shorthands to their lexical value for TDZ analysis", async () => {
    const result = await compileMulti(
      {
        "entry.js": [
          "const CALL = 41;",
          "const api = { CALL };",
          "export function test() {",
          "  return api.CALL === CALL ? 1 : 0;",
          "}",
        ].join("\n"),
      },
      "entry.js",
      { allowJs: true, target: "gc", platform: "node", deferTopLevelInit: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    if (!result.success) return;

    const imports = buildImports(result.imports as never, undefined, result.stringPool);
    const instance = await WebAssembly.instantiate(result.binary, imports as never);
    if (typeof (imports as { setExports?: (exports: WebAssembly.Exports) => void }).setExports === "function") {
      (imports as { setExports: (exports: WebAssembly.Exports) => void }).setExports(instance.instance.exports);
    }
    (instance.instance.exports.__module_init as () => void)();
    expect((instance.instance.exports.test as () => number)()).toBe(1);
  });

  it("passes the ambient process object through in the Node host lane", async () => {
    const result = await compileMulti(
      {
        "entry.js": [
          "export function test() {",
          '  return typeof process !== "undefined" && process.type === undefined && process.browser !== true ? 1 : 0;',
          "}",
        ].join("\n"),
      },
      "entry.js",
      { allowJs: true, target: "gc", platform: "node" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    if (!result.success) return;

    const imports = buildImports(result.imports as never, undefined, result.stringPool);
    const instance = await WebAssembly.instantiate(result.binary, imports as never);
    if (typeof (imports as { setExports?: (exports: WebAssembly.Exports) => void }).setExports === "function") {
      (imports as { setExports: (exports: WebAssembly.Exports) => void }).setExports(instance.instance.exports);
    }
    expect((instance.instance.exports.test as () => number)()).toBe(1);
  });

  it("forwards a lifted nested function's transitive captures through host callbacks", async () => {
    const result = await compileMulti(
      {
        "entry.js": [
          "function compileAsync(schemaObj, self, meta) {",
          "  return Promise.resolve().then(function () {",
          "    return _compileAsync(schemaObj);",
          "  });",
          "  function _compileAsync(value) {",
          "    return self + meta + value;",
          "  }",
          "}",
          "export function test() { return compileAsync(2, 4, 3); }",
        ].join("\n"),
      },
      "entry.js",
      { allowJs: true, target: "gc", platform: "node" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    if (!result.success) return;
    expect(WebAssembly.validate(result.binary)).toBe(true);

    const imports = buildImports(result.imports as never, undefined, result.stringPool);
    const instance = await WebAssembly.instantiate(result.binary, imports as never);
    if (typeof (imports as { setExports?: (exports: WebAssembly.Exports) => void }).setExports === "function") {
      (imports as { setExports: (exports: WebAssembly.Exports) => void }).setExports(instance.instance.exports);
    }
    await expect((instance.instance.exports.test as () => Promise<number>)()).resolves.toBe(9);
  });

  it("keeps JSDoc/declaration-only roots available to the checker without emitting their bodies", async () => {
    const previousProfile = process.env.JS2WASM_PROFILE_COMPILE;
    const profileLines: string[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => {
      profileLines.push(values.map(String).join(" "));
    });
    process.env.JS2WASM_PROFILE_COMPILE = "1";

    let result: CompileResult;
    try {
      result = await compileProject(join(fixtureRoot, "entry.js"), {
        allowJs: true,
        target: "gc",
        platform: "node",
      });
    } finally {
      consoleError.mockRestore();
      if (previousProfile === undefined) {
        delete process.env.JS2WASM_PROFILE_COMPILE;
      } else {
        process.env.JS2WASM_PROFILE_COMPILE = previousProfile;
      }
    }
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    if (!result.success) return;

    const profile = profileLines
      .filter((line) => line.startsWith(COMPILE_PROFILE_MARKER))
      .map((line) => JSON.parse(line.slice(COMPILE_PROFILE_MARKER.length)) as Record<string, unknown>);
    expect(profile.map((entry) => entry.phase)).toEqual(
      expect.arrayContaining([
        "project.graph",
        "multi.checker",
        "codegen.declarations",
        "codegen.function-bodies",
        "pipeline.binary",
        "project.total",
      ]),
    );
    expect(profile.find((entry) => entry.phase === "multi.checker")).toMatchObject({
      checkerFiles: 4,
      codegenFiles: 2,
    });
    const sourceBodyProfiles = profile.filter((entry) => entry.phase === "codegen.source-bodies");
    expect(sourceBodyProfiles).toHaveLength(2);
    expect(sourceBodyProfiles.filter((entry) => entry.sharedModuleInit === true)).toHaveLength(1);
    expect(profile.every((entry) => typeof entry.maxRssBytes === "number")).toBe(true);

    const imports = buildImports(result.imports as never, undefined, result.stringPool);
    const instance = await WebAssembly.instantiate(result.binary, imports as never);
    if (typeof (imports as { setExports?: (exports: WebAssembly.Exports) => void }).setExports === "function") {
      (imports as { setExports: (exports: WebAssembly.Exports) => void }).setExports(instance.instance.exports);
    }
    expect((instance.instance.exports.answer as () => number)()).toBe(42);
  });
});
