// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4759 — a relative self-import is a module-graph edge, not an ambient
// namespace declaration. Keep the regression small enough to exercise both
// host and standalone linking without depending on Test262's exotic-object
// surface, which remains a separate follow-up cluster.

import { describe, expect, it } from "vitest";
import { hasSelfModuleImport } from "../scripts/test262-fixture-graph.mjs";
import { compileMulti } from "../src/index.js";
import { join } from "node:path";
import { runTest262File } from "./test262-runner.js";

const LITERAL_SELF_NAMESPACE_ROW = join(
  import.meta.dirname ?? ".",
  "..",
  "test262",
  "test",
  "language",
  "module-code",
  "namespace",
  "internals",
  "set-prototype-of-null.js",
);

async function runSelfNamespace(target: "gc" | "standalone"): Promise<number> {
  const entry = "./entry.js";
  const source = `
    import * as self from "./entry.js";
    export function answer() { return 32; }
    export function test() { return self.answer() + (self === self ? 10 : 0); }
  `;
  const result = await compileMulti({ [entry]: source }, entry, {
    target,
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  if (!result.success) return 0;

  const imports = (result.importObject ?? {}) as Record<string, unknown>;
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  const setExports = imports.__setExports ?? imports.setExports;
  if (typeof setExports === "function") (setExports as (exports: WebAssembly.Exports) => void)(instance.exports);
  const setInstance = imports.__setInstance ?? imports.setInstance;
  if (typeof setInstance === "function") (setInstance as (instance: WebAssembly.Instance) => void)(instance);
  const moduleInit = (instance.exports as Record<string, unknown>).__module_init;
  if (typeof moduleInit === "function") (moduleInit as () => void)();
  return (instance.exports as Record<string, () => number>).test();
}

async function runEmptySelfNamespace(target: "gc" | "standalone"): Promise<void> {
  const entry = "./entry.js";
  const source = `
    import * as self from "./entry.js";
    if (Object.setPrototypeOf(self, null) !== self) {
      throw new Error("self namespace identity was not preserved");
    }
  `;
  const result = await compileMulti({ [entry]: source }, entry, {
    target,
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  if (!result.success) return;

  const imports = (result.importObject ?? {}) as Record<string, unknown>;
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  const setInstance = imports.__setInstance ?? imports.setInstance;
  if (typeof setInstance === "function") (setInstance as (instance: WebAssembly.Instance) => void)(instance);
  const moduleInit = (instance.exports as Record<string, unknown>).__module_init;
  if (typeof moduleInit === "function") (moduleInit as () => void)();
}

describe("#4759 module namespace self-import linking", () => {
  it("recognizes only a static relative self-import", () => {
    const path = "language/module-code/namespace/Symbol.iterator.js";
    expect(hasSelfModuleImport(path, `import * as ns from "./Symbol.iterator.js";`)).toBe(true);
    expect(hasSelfModuleImport(path, `export { answer } from "./Symbol.iterator.js";`)).toBe(true);
    expect(hasSelfModuleImport(path, `import("./Symbol.iterator.js");`)).toBe(false);
    expect(hasSelfModuleImport(path, `/* import * as ns from "./Symbol.iterator.js"; */`)).toBe(false);
    expect(hasSelfModuleImport(path, `import * as other from "./other.js";`)).toBe(false);
  });

  it.each(["gc", "standalone"] as const)("resolves the self namespace in %s", async (target) => {
    await expect(runSelfNamespace(target)).resolves.toBe(42);
  });

  it.each(["gc", "standalone"] as const)("materializes an empty self namespace in %s", async (target) => {
    await expect(runEmptySelfNamespace(target)).resolves.toBeUndefined();
  });

  it.each(["gc", "standalone"] as const)(
    "executes the literal Test262 row in %s",
    async (target) => {
      const result = await runTest262File(
        LITERAL_SELF_NAMESPACE_ROW,
        "issue-4759-literal",
        120_000,
        target === "standalone" ? target : undefined,
      );
      expect(result.status, result.error ?? `${result.file} did not pass`).toBe("pass");
    },
    180_000,
  );
});
