// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Shared test-only helpers extracted from the #7010 native-generator controls.
// runNativeFirst intentionally preserves their exact compile options. At the
// pinned target-profile boundary, omitted target is GC; native-first is explicit.
import ts from "typescript";
import { expect } from "vitest";
import { compile } from "../../src/index.js";
import { buildImports, wrapCompiledExports } from "../../src/runtime.js";

const GEN_IMPORT = /^(__gen_|__create_generator$|__create_async_generator$)/;

export function genImports(r: { imports?: readonly { name: string }[] }): string[] {
  return (r.imports ?? []).map((i) => i.name).filter((n) => GEN_IMPORT.test(n));
}

export async function jsOracle(src: string): Promise<string> {
  const js = ts.transpileModule(src, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exp: Record<string, () => unknown> = {};
  new Function("exports", "module", js)(exp, { exports: exp });
  return String(await exp.test!());
}

export async function runNativeFirst(src: string): Promise<string> {
  const r = await compile(src, { fileName: "test.ts", semanticProviders: "native-first" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  expect(genImports(r)).toEqual([]);
  expect(WebAssembly.validate(r.binary)).toBe(true);
  expect(WebAssembly.Module.imports(new WebAssembly.Module(r.binary)).filter((i) => GEN_IMPORT.test(i.name))).toEqual(
    [],
  );
  const built = buildImports(r.imports, undefined, r.stringPool) as Record<string, unknown> & {
    setExports?: (exports: WebAssembly.Exports) => void;
  };
  const imports: WebAssembly.Imports = {
    env: built.env as WebAssembly.ModuleImports,
    string_constants: built.string_constants as WebAssembly.ModuleImports,
  };
  if (built["wasm:js-string"]) imports["wasm:js-string"] = built["wasm:js-string"] as WebAssembly.ModuleImports;
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  built.setExports?.(instance.exports);
  return String(await (wrapCompiledExports(r, instance).test as () => unknown)());
}
