// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { compile } from "../src/index.js";
import { planIrCompilation } from "../src/ir/select.js";
import { buildImports } from "../src/runtime.js";

async function runScript(source: string, target?: "standalone"): Promise<Record<string, unknown>> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-2726-global-environment-delete.js",
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
    deferTopLevelInit: true,
    ...(target ? { target } : {}),
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);

  const sandbox: Record<string, unknown> = {};
  const imports = target ? {} : buildImports(result.imports, undefined, result.stringPool, { globalSandbox: sandbox });
  if (target) {
    expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
  }
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  if (!target) {
    (imports as ReturnType<typeof buildImports>).setExports?.(instance.exports as Record<string, Function>);
  }
  const moduleInit = (instance.exports as { __module_init?: () => void }).__module_init;
  expect(typeof moduleInit).toBe("function");
  moduleInit?.();
  return sandbox;
}

const declaredVarSource = `
  var __issue_2726_declared_var__ = 1;
  if (delete __issue_2726_declared_var__ !== false) {
    throw new Error("bare var binding became deletable");
  }
  if (delete this.__issue_2726_declared_var__ !== false) {
    throw new Error("script var property became deletable");
  }
`;

const implicitGlobalSource = `
  try {
    __issue_2726_implicit_global__ = 1;
    if (__issue_2726_implicit_global__ !== 1) {
      throw new Error("implicit-global read missed its property");
    }
    if (delete __issue_2726_implicit_global__ !== true) {
      throw new Error("implicit-global delete was refused");
    }
    __issue_2726_implicit_global__;
    throw new Error("deleted implicit global remained resolvable");
  } catch (error) {
    if (!(error instanceof ReferenceError)) throw error;
  }
`;

describe("#2726 residual global-environment delete semantics", () => {
  it("keeps top-level this property deletes off the constant-true IR path", () => {
    const sourceFile = ts.createSourceFile(
      "issue-2726.js",
      "var y = 1; delete this.y;",
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.JS,
    );
    const selection = planIrCompilation(sourceFile, { experimentalIR: true, trackFallbacks: true });
    expect(selection.moduleInit?.reason).toBe("body-shape-rejected");
  });

  it("keeps a script var non-configurable through top-level this (host)", async () => {
    await runScript(declaredVarSource);
  });

  it("keeps a script var non-configurable through top-level this (standalone)", async () => {
    await runScript(declaredVarSource, "standalone");
  });

  it("creates, reads, deletes, and unresolves an implicit global (host)", async () => {
    const sandbox = await runScript(implicitGlobalSource);
    expect(Object.hasOwn(sandbox, "__issue_2726_implicit_global__")).toBe(false);
  });

  it("creates, reads, deletes, and unresolves an implicit global (standalone)", async () => {
    await runScript(implicitGlobalSource, "standalone");
  });
});
