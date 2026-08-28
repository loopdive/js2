// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { runTest262File } from "./test262-runner.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEST262_ROOT = join(REPO_ROOT, "test262");
const EXACT_ROWS = [
  "test/annexB/built-ins/escape/to-string-err-symbol.js",
  "test/annexB/built-ins/unescape/to-string-err-symbol.js",
] as const;
const TEST262_READY =
  existsSync(join(TEST262_ROOT, "harness", "assert.js")) &&
  EXACT_ROWS.every((relativePath) => existsSync(join(TEST262_ROOT, relativePath)));

type ExportedTest = { test: () => unknown };

async function runCompiled(
  source: string,
  target?: "standalone",
): Promise<{ exports: ExportedTest; imports: unknown[] }> {
  const result = await compile(source, {
    ...(target ? { target } : {}),
    fileName: "issue-5123-es2015-escape-symbol-tostring.ts",
    skipSemanticDiagnostics: true,
  });
  if (!result.success) throw new Error(result.errors.map((error) => error.message).join("\n"));

  const imports = result.imports as unknown[];
  if (target === "standalone") {
    const moduleImports = WebAssembly.Module.imports(new WebAssembly.Module(result.binary));
    if (moduleImports.length !== 0) throw new Error(`standalone import leak: ${JSON.stringify(moduleImports)}`);
  }
  const importObject =
    target === "standalone" ? {} : (buildImports(result.imports, undefined, result.stringPool) as any);
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  if (typeof importObject.setExports === "function") importObject.setExports(instance.exports);
  return { exports: instance.exports as unknown as ExportedTest, imports };
}

const SYMBOL_CALLS_SOURCE = `
  const beforeEscape: any = escape;
  const beforeUnescape: any = unescape;

  function catchesSymbol(fn: any, value: any): number {
    try {
      fn(value);
      return 0;
    } catch (error) {
      return error instanceof TypeError ? 1 : 100;
    }
  }

  export function test(): number {
    const staticSymbol: symbol = Symbol("static");
    const dynamicSymbol: any = staticSymbol;
    let score = 0;
    try { escape(staticSymbol); } catch (error) { score += error instanceof TypeError ? 1 : 100; }
    try { unescape(staticSymbol); } catch (error) { score += error instanceof TypeError ? 1 : 100; }
    score += catchesSymbol(beforeEscape, dynamicSymbol);
    score += catchesSymbol(beforeUnescape, dynamicSymbol);
    score += catchesSymbol(globalThis.escape, dynamicSymbol);
    score += catchesSymbol(globalThis.unescape, dynamicSymbol);
    try { globalThis.escape(staticSymbol); } catch (error) { score += error instanceof TypeError ? 1 : 100; }
    try { globalThis.unescape(staticSymbol); } catch (error) { score += error instanceof TypeError ? 1 : 100; }
    score += catchesSymbol(escape, dynamicSymbol);
    score += catchesSymbol(unescape, dynamicSymbol);
    return score + (String(Symbol("printable")) === "Symbol(printable)" ? 1 : 0);
  }
`;

const ARGUMENT_ORDER_SOURCE = `
  let order = 0;
  let firstCalls = 0;
  let secondCalls = 0;
  let abruptCalls = 0;

  function first(): any {
    firstCalls += 1;
    order = order * 10 + 1;
    return Symbol("first");
  }
  function second(): any {
    secondCalls += 1;
    order = order * 10 + 2;
    return "second";
  }
  function laterAbrupt(): any {
    abruptCalls += 1;
    order = order * 10 + 3;
    throw new Error("later");
  }

  function checkEscape(): number {
    try {
      escape(first(), second(), laterAbrupt(), second());
      return 0;
    } catch (error) {
      return order === 123 && firstCalls === 1 && secondCalls === 1 && abruptCalls === 1 &&
        error instanceof Error && !(error instanceof TypeError) ? 1 : 0;
    }
  }

  function checkUnescape(): number {
    order = 0;
    firstCalls = 0;
    secondCalls = 0;
    abruptCalls = 0;
    try {
      unescape(first(), second(), laterAbrupt(), second());
      return 0;
    } catch (error) {
      return order === 123 && firstCalls === 1 && secondCalls === 1 && abruptCalls === 1 &&
        error instanceof Error && !(error instanceof TypeError) ? 1 : 0;
    }
  }

  export function test(): number {
    return checkEscape() + checkUnescape();
  }
`;

const POSITIVE_SOURCE = `
  export function test(): number {
    return escape() === "undefined" &&
      unescape() === "undefined" &&
      escape("A B") === "A%20B" &&
      unescape("A%20B") === "A B" &&
      escape(65) === "65" &&
      unescape(65) === "65" ? 1 : 0;
  }
`;

const HOST_SYMBOL_SOURCE = `
  function directTypeErrorEscape(): number {
    try {
      escape(Symbol("escape"));
      return 0;
    } catch (error) {
      return error instanceof TypeError && error.name === "TypeError" ? 1 : 100;
    }
  }

  function directTypeErrorUnescape(): number {
    try {
      unescape(Symbol("unescape"));
      return 0;
    } catch (error) {
      return error instanceof TypeError && error.name === "TypeError" ? 1 : 100;
    }
  }

  export function test(): number {
    return directTypeErrorEscape() +
      directTypeErrorUnescape() +
      (escape() === "undefined" ? 1 : 0) +
      (unescape() === "undefined" ? 1 : 0) +
      (escape("A B") === "A%20B" ? 1 : 0) +
      (unescape("A%20B") === "A B" ? 1 : 0) +
      (escape(65) === "65" ? 1 : 0) +
      (unescape(65) === "65" ? 1 : 0);
  }
`;

describe("#5123 ES2015 escape/unescape Symbol coercion", () => {
  it("rejects static and dynamic Symbols through direct, aliased, and globalThis calls", async () => {
    const { exports } = await runCompiled(SYMBOL_CALLS_SOURCE, "standalone");
    expect(exports.test()).toBe(11);
  });

  it("evaluates every argument once and lets a later abrupt extra win", async () => {
    const { exports } = await runCompiled(ARGUMENT_ORDER_SOURCE, "standalone");
    expect(exports.test()).toBe(2);
  });

  it("preserves omitted, string, and number results without standalone imports", async () => {
    const { exports, imports } = await runCompiled(POSITIVE_SOURCE, "standalone");
    expect(exports.test()).toBe(1);
    expect(imports).toEqual([]);
  });

  it("keeps the host direct route's argument evaluation and Symbol error behavior", async () => {
    const { exports } = await runCompiled(ARGUMENT_ORDER_SOURCE);
    expect(exports.test()).toBe(2);
  });

  it("keeps host direct Symbol TypeErrors exact and preserves positive arguments", async () => {
    const { exports } = await runCompiled(HOST_SYMBOL_SOURCE);
    expect(exports.test()).toBe(8);
  });
});

describe.skipIf(!TEST262_READY)("#5123 exact Test262 rows", () => {
  it.each(EXACT_ROWS)(
    "passes %s in the host lane",
    async (relativePath) => {
      const result = await runTest262File(join(TEST262_ROOT, relativePath), "issue-5123-host", 120_000);
      expect(result.status, `${relativePath}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
    },
    180_000,
  );

  it.each(EXACT_ROWS)(
    "passes %s in standalone without imports",
    async (relativePath) => {
      const result = await runTest262File(
        join(TEST262_ROOT, relativePath),
        "issue-5123-standalone",
        120_000,
        "standalone",
      );
      expect(result.status, `${relativePath}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
    },
    180_000,
  );
});
