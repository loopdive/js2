// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runTopLevel(source: string): Promise<void> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-3365.js",
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  (instance.exports.__module_init as (() => void) | undefined)?.();
}

const ORIGINAL_ASSERT = readFileSync(new URL("../test262/harness/assert.js", import.meta.url), "utf8");
const ORIGINAL_STA = readFileSync(new URL("../test262/harness/sta.js", import.meta.url), "utf8");

function sourceFor(property: "undefined" | "Infinity"): string {
  return `
    "use strict";
    ${ORIGINAL_ASSERT}
    ${ORIGINAL_STA}
    var globalObject = this;
    assert.throws(TypeError, function () {
      globalObject.${property} = 42;
    });
  `;
}

describe("#3365 script top-level this global assignments", () => {
  it("keeps top-level this bindings on the host global for original assert.throws", async () => {
    await runTopLevel(sourceFor("undefined"));
    await runTopLevel(sourceFor("Infinity"));
  });
});
