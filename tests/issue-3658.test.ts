// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3658 — keep checker-only project roots out of multi-module codegen.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { COMPILE_PROFILE_MARKER } from "../src/compile-profile.js";
import { compileProject, type CompileResult } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

let fixtureRoot: string;

function write(path: string, source: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
}

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "js2wasm-3658-"));
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

describe("#3658 — project codegen reachability", () => {
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
    expect(profile.every((entry) => typeof entry.maxRssBytes === "number")).toBe(true);

    const imports = buildImports(result.imports as never, undefined, result.stringPool);
    const instance = await WebAssembly.instantiate(result.binary, imports as never);
    if (typeof (imports as { setExports?: (exports: WebAssembly.Exports) => void }).setExports === "function") {
      (imports as { setExports: (exports: WebAssembly.Exports) => void }).setExports(instance.instance.exports);
    }
    expect((instance.instance.exports.answer as () => number)()).toBe(42);
  });
});
