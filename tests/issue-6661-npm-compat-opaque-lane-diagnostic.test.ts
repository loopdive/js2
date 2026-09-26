// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6661 — npm-compat perf lanes must name the real reason a package is not
// runnable. Two harness defects hid it:
//   1. a JS-host package-entry report that failed was rendered as the generic
//      "package entry did not produce a runnable Wasm module" (the helper read
//      fields the report never has), or as the first — non-fatal — TS8xxx
//      "X can only be used in TypeScript files" diagnostic;
//   2. the extracted jest tarball could not be imported natively ("Cannot find
//      module 'jest-config'") because pnpm's hoist fallback was not wired.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { packageEntryBlockReason } from "./dogfood/package-entry-harness.mjs";
import { setupNpmCompatCatalogPackage } from "./dogfood/npm-compat-catalog.mjs";

const OPAQUE = "package entry did not produce a runnable Wasm module";

// The pre-#6661 helper, verbatim, as the anti-vacuity control.
function legacyReportCompileDiagnostic(report: any): string {
  return (
    report?.compile?.error ??
    report?.compile?.errors?.[0]?.message ??
    report?.compile?.diagnostics?.[0]?.messageText ??
    report?.validation?.error ??
    OPAQUE
  );
}

// Report shapes as recorded in benchmarks/results/npm-compat.json (2026-09-23).
const TIMEOUT = {
  compile: { success: false, timedOut: true, timeoutMs: 600000, errorCount: 0, categories: {} },
  validation: { validates: false, firstError: "compileProject exceeded the 600000ms budget" },
};
const NOISE_THEN_CODEGEN = {
  compile: {
    success: false,
    timedOut: false,
    timeoutMs: 120000,
    errorCount: 3,
    errors: [
      { message: "Signature declarations can only be used in TypeScript files.", file: "lodash.js" },
      { message: "Type annotations can only be used in TypeScript files.", file: "lodash.js" },
      { message: "Codegen error: stack-balance invariant (entry): '__cb_11' references local 327" },
    ],
  },
  validation: { validates: false, firstError: "Signature declarations can only be used in TypeScript files." },
};
const COMPILED_BUT_INVALID = {
  compile: {
    success: true,
    timedOut: false,
    errorCount: 1,
    errors: [{ message: "Signature declarations can only be used in TypeScript files." }],
  },
  validation: {
    validates: false,
    firstError: 'WebAssembly.Module(): Compiling function #445:"Ce" failed: struct.get[0] expected type (ref null 265)',
  },
};
const FAILED_WITHOUT_ERRORS = {
  compile: { success: false, timedOut: false, errorCount: 0, categories: {} },
  validation: { validates: false, firstError: "Internal error compiling function 't_x': nested function changed ABI" },
};

describe("#6661 npm-compat package-entry block reason", () => {
  it("control: the legacy helper was opaque or named non-fatal noise", () => {
    expect(legacyReportCompileDiagnostic(TIMEOUT)).toBe(OPAQUE);
    expect(legacyReportCompileDiagnostic(FAILED_WITHOUT_ERRORS)).toBe(OPAQUE);
    expect(legacyReportCompileDiagnostic(NOISE_THEN_CODEGEN)).toMatch(/can only be used in TypeScript files/);
    expect(legacyReportCompileDiagnostic(COMPILED_BUT_INVALID)).toMatch(/can only be used in TypeScript files/);
  });

  it("names the failing gate and its real reason for every shape", () => {
    const reasons = [TIMEOUT, NOISE_THEN_CODEGEN, COMPILED_BUT_INVALID, FAILED_WITHOUT_ERRORS].map(
      packageEntryBlockReason,
    );
    for (const reason of reasons) {
      expect(reason).not.toBe(OPAQUE);
      expect(reason).not.toMatch(/can only be used in TypeScript files/);
      expect(reason).toMatch(/^JS-host package-entry /);
    }
    expect(reasons[0]).toBe(
      "JS-host package-entry compile exceeded the 600000ms harness budget (compile-budget; lane not attempted)",
    );
    expect(reasons[1]).toBe(
      "JS-host package-entry compile failed: Codegen error: stack-balance invariant (entry): '__cb_11' references local 327",
    );
    expect(reasons[2]).toMatch(/^JS-host package-entry binary is invalid: WebAssembly\.Module\(\): Compiling function/);
    expect(reasons[3]).toBe(
      "JS-host package-entry compile failed: Internal error compiling function 't_x': nested function changed ABI",
    );
  });
});

// The extracted jest tarball requires `jest-config`, which jest does not
// declare; the installed copy finds it through pnpm's `.pnpm/node_modules`
// hoist directory. Only meaningful on a pnpm install with jest present.
const jestInstalled = existsSync(join(__dirname, "..", "node_modules", "jest"));

function nativeImport(entry: string): string {
  try {
    execFileSync(
      process.execPath,
      ["--input-type=module", "-e", `await import(${JSON.stringify(entry)}); console.log("ok");`],
      { encoding: "utf-8", stdio: "pipe" },
    );
    return "ok";
  } catch (error: any) {
    return String(error?.stderr ?? error?.message ?? error)
      .split("\n")
      .find((line: string) => line.startsWith("Error"))!;
  }
}

describe.skipIf(!jestInstalled)("#6661 npm-compat catalog native import (jest)", () => {
  it("resolves jest's undeclared jest-config through the pnpm hoist fallback", () => {
    const setup = setupNpmCompatCatalogPackage("jest");
    // The repository installs with pnpm (pnpm-lock.yaml), so the link exists.
    expect(setup.hoistedNodeModulesPath).toBe(join(__dirname, "dogfood", ".npm-compat", "node_modules"));
    expect(nativeImport(setup.entryModulePath)).toBe("ok");

    // Control, without mutating the shared link (other catalog setups running
    // in parallel would recreate it): the importer directory that was the only
    // fallback before #6661 does NOT contain jest-config — the hoist directory
    // is what makes the import resolve.
    expect(existsSync(join(setup.dependencyNodeModulesPath, "jest-config"))).toBe(false);
    expect(existsSync(join(setup.hoistedNodeModulesPath, "jest-config"))).toBe(true);
  });
});
