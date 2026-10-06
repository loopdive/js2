// #6875 — `.length` / index on a dynamically typed native string reaches
// `__extern_get` with the string as RECEIVER; the helper had no arm for it.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";
import { buildCompiledImports, wrapCompiledExports } from "../src/runtime.js";

const SRC = `export function len(input) { return input.length; }
export function at(input, i) { return input[i]; }
export function routes(input) { const a = []; a.push(1); return a.length + input.length; }
export function probe() { const v = JSON.parse('"abcd"'); return len(v) == 4 && at(v, 2) == "c" && at(v, 9) === undefined ? 1 : 0; }
`;

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "issue-6875-"));
  const file = join(dir, "main.mjs");
  writeFileSync(file, SRC);
  return file;
}

describe("#6875 native-string receiver in __extern_get", () => {
  it("answers length and index for an untyped parameter under --target standalone", async () => {
    const result = await compileProject(project(), {
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "standalone",
    });
    expect(result.success, result.errors.map((e) => e.message).join("; ")).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    (instance.exports as { __module_init?: () => void }).__module_init?.();
    expect((instance.exports as { probe: () => number }).probe()).toBe(1);
  });

  it("answers length and index for a JS string passed into the native regime", async () => {
    const result = await compileProject(project(), {
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "gc",
      semanticProviders: "native-first",
    });
    expect(result.success, result.errors.map((e) => e.message).join("; ")).toBe(true);
    const imports = buildCompiledImports(result);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    (instance.exports as { __module_init?: () => void }).__module_init?.();
    const exports = wrapCompiledExports(result, instance) as Record<string, (...args: unknown[]) => unknown>;
    expect(exports.len("/users/1")).toBe(8);
    expect(exports.at("/users/1", 1)).toBe("u");
    expect(exports.routes("/users/1")).toBe(9);
  });
});
