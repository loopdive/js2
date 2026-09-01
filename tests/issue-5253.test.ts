// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5253 — direct top-level lexical reads before their own declaration.
//
// A bare `x;` normally has no observable work, so module-init collection may
// record and omit it.  This is only sound when `x` is not a same-source lexical
// binding whose declaration comes later: in that narrow case GetValue is a
// guaranteed TDZ ReferenceError.
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { compile, type CompileResult } from "../src/index.js";
import { renderHarnessThrownText } from "../scripts/lib/wasm-exn-render.mjs";
import { runTest262File } from "./test262-runner.js";

type LexicalKind = "let" | "const";

const TEST262_FORWARD_READ_ROWS = [
  "language/statements/const/global-use-before-initialization-in-prior-statement.js",
  "language/statements/let/global-use-before-initialization-in-prior-statement.js",
] as const;

function directForwardReadSource(kind: LexicalKind): string {
  return kind === "const" ? "x; const x = 1;" : "x; let x;";
}

function caughtForwardReadSource(kind: LexicalKind): string {
  return `
    let verdict = 0;
    try {
      x;
    } catch (error: any) {
      verdict = error instanceof ReferenceError ? 1 : 2;
    }
    ${kind} x: number = 1;
    export function test(): number { return verdict; }
  `;
}

const NON_MATCHING_TOP_LEVEL_CONTROLS = [
  {
    label: "post-initialization let read",
    source: "let x = 1; x;",
    outcome: "complete",
  },
  {
    label: "post-initialization const read",
    source: "const x = 1; x;",
    outcome: "complete",
  },
  {
    label: "forward var read",
    source: "x; var x = 1;",
    outcome: "complete",
  },
  {
    label: "block-local forward lexical read (#5154)",
    source: "{ x; let x = 1; }",
    outcome: "complete",
  },
  {
    label: "unbound bare identifier",
    source: "x;",
    outcome: "complete",
  },
] as const;

function importNames(result: CompileResult): string[] {
  return WebAssembly.Module.imports(new WebAssembly.Module(result.binary))
    .map((entry) => `${entry.module}.${entry.name}`)
    .sort();
}

function expectStandaloneHostFree(result: CompileResult): void {
  expect(result.imports, "standalone compiler import descriptors").toEqual([]);
  expect(importNames(result), "standalone Wasm import section").toEqual([]);
  expect(result.hostImportSummary?.total ?? 0, "standalone host-import inventory").toBe(0);
}

function runModuleInit(instance: WebAssembly.Instance): unknown {
  try {
    const init = instance.exports.__module_init;
    if (typeof init === "function") init();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("#5253 — retain guaranteed top-level TDZ reads", () => {
  it.each(TEST262_FORWARD_READ_ROWS)("passes the exact standalone Test262 row %s", async (relativePath) => {
    const result = await runTest262File(
      resolve("test262/test", relativePath),
      "language/statements",
      undefined,
      "standalone",
    );
    expect(result.status, result.reason ?? result.error).toBe("pass");
  });

  it.each(["let", "const"] as const)(
    "retains the direct script-level forward %s read in standalone without host imports",
    async (kind) => {
      const result = await compile(directForwardReadSource(kind), {
        allowJs: true,
        deferTopLevelInit: true,
        fileName: `issue-5253-direct-${kind}.js`,
        hostBridge: "always",
        inferModuleStrictArguments: false,
        skipSemanticDiagnostics: true,
        target: "standalone",
      });
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expectStandaloneHostFree(result);
      const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), {});
      const thrown = runModuleInit(instance);
      expect(thrown, "module init must observe the TDZ read").toBeDefined();
      expect(renderHarnessThrownText(thrown, instance)).toContain("ReferenceError");
    },
  );

  it.each(["let", "const"] as const)(
    "retains the same direct script-level forward %s read in the host/GC control",
    async (kind) => {
      const result = await compile(directForwardReadSource(kind), {
        allowJs: true,
        deferTopLevelInit: true,
        fileName: `issue-5253-host-${kind}.js`,
        hostBridge: "always",
        inferModuleStrictArguments: false,
        skipSemanticDiagnostics: true,
        target: "gc",
      });
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), result.importObject);
      const thrown = runModuleInit(instance);
      expect(thrown, "module init must observe the TDZ read").toBeDefined();
      expect(renderHarnessThrownText(thrown, instance)).toContain("ReferenceError");
    },
  );

  it.each(["let", "const"] as const)(
    "builds a real in-module ReferenceError for a caught top-level forward %s read",
    async (kind) => {
      const result = await compile(caughtForwardReadSource(kind), {
        deferTopLevelInit: true,
        fileName: `issue-5253-caught-${kind}.ts`,
        skipSemanticDiagnostics: true,
        target: "standalone",
      });
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expectStandaloneHostFree(result);
      const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), {});
      expect(runModuleInit(instance)).toBeUndefined();
      expect((instance.exports.test as () => number)()).toBe(1);
    },
  );

  it.each(NON_MATCHING_TOP_LEVEL_CONTROLS)(
    "leaves the $label control outside the direct top-level lexical proof",
    async ({ label, source, outcome }) => {
      const result = await compile(source, {
        allowJs: true,
        deferTopLevelInit: true,
        fileName: `issue-5253-control-${label}.js`,
        hostBridge: "always",
        inferModuleStrictArguments: false,
        skipSemanticDiagnostics: true,
        target: "standalone",
      });
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expectStandaloneHostFree(result);
      const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), {});
      const thrown = runModuleInit(instance);
      if (outcome === "reference-error") {
        expect(thrown, `${label} must retain its existing TDZ behavior`).toBeDefined();
        expect(renderHarnessThrownText(thrown, instance)).toContain("ReferenceError");
      } else {
        // The generic atom collector remains intentionally unchanged here:
        // post-init and var reads are inert; the block-local gap is #5154;
        // and unbound reads stay #3623 work rather than being misclassified
        // as a lexical TDZ proof.
        expect(thrown, `${label} must not enter #5253's TDZ exception`).toBeUndefined();
      }
    },
  );
});
