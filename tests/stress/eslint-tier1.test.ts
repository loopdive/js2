// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1282 / #1400 — first honest ESLint Tier 1 proof.
//
// This deliberately runs in the WasmGC JavaScript-host lane under Node.
// Builtin `node:*` dependencies remain real Node host imports; standalone/WASI
// implementations are a separate portability milestone.

import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { ESLINT_DEV_DEPENDENCY_SKIP, resolveEslintFile } from "../helpers/eslint.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const execFileAsync = promisify(execFile);
const TMP_DIR = resolve(__dirname, "../../.tmp/eslint-tier1");
const COMPILE_PROJECT_PROBE = resolve(__dirname, "../helpers/compile-project-probe.ts");
const COMPILE_PROJECT_PROBE_MARKER = "__JS2_COMPILE_PROJECT_PROBE__";
const ESLINT_LINTER = resolveEslintFile("lib/linter/linter.js");

interface CompileProjectProbe {
  success: boolean;
  binaryByteLength: number;
  valid: boolean;
  instantiated: boolean;
  runtimeValue?: unknown;
  runtimeError?: string;
  hostFailure?: string;
  validationError?: string;
  wasmImports: Array<{ module: string; name: string; kind: WebAssembly.ImportExportKind }>;
  errors: Array<{ message: string }>;
}

function writeEntry(): string {
  mkdirSync(TMP_DIR, { recursive: true });
  const entry = join(TMP_DIR, "tier1-entry.js");
  writeFileSync(
    entry,
    [
      'const linterModule = require("../../node_modules/eslint/lib/linter/linter.js");',
      "const Linter = linterModule.Linter;",
      "const linter = new Linter();",
      "export function test() {",
      '  const messages = linter.verify("const x = 1;", {});',
      "  return Array.isArray(messages) ? messages.length : -1;",
      "}",
      "",
    ].join("\n"),
  );
  return entry;
}

async function runProbe(): Promise<CompileProjectProbe> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        COMPILE_PROJECT_PROBE,
        writeEntry(),
        JSON.stringify({
          allowJs: true,
          target: "gc",
          platform: "node",
          deferTopLevelInit: true,
          emitWat: false,
        }),
        "test",
      ],
      {
        cwd: resolve(__dirname, "../.."),
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: 3_600_000,
      },
    ));
  } catch (error) {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    throw new Error(`ESLint compile probe failed or exceeded its 3600s budget:\n${detail}`, {
      cause: error,
    });
  }
  const marker = stdout.lastIndexOf(COMPILE_PROJECT_PROBE_MARKER);
  if (marker === -1) throw new Error(`compileProject probe emitted no structured report:\n${stdout}`);
  return JSON.parse(stdout.slice(marker + COMPILE_PROJECT_PROBE_MARKER.length).trim()) as CompileProjectProbe;
}

describe.skipIf(ESLINT_LINTER === null)(`#1282/#1400 ESLint Tier 1 ${ESLINT_DEV_DEPENDENCY_SKIP}`, () => {
  it("compiles, validates, instantiates, and runs Linter.verify in the Node JS-host lane", async () => {
    const result = await runProbe();
    const diagnostics = result.errors.map((error) => error.message).join("\n");

    expect(result.success, diagnostics).toBe(true);
    expect(result.binaryByteLength).toBeGreaterThan(0);
    expect(result.valid, result.validationError).toBe(true);
    expect(result.wasmImports).toContainEqual({
      module: "env",
      name: "__node_path",
      kind: "function",
    });
    expect(result.instantiated, result.hostFailure ?? result.runtimeError).toBe(true);
    expect(result.runtimeError, result.hostFailure).toBeUndefined();
    expect(result.runtimeValue).toBe(0);
  }, 3_660_000);
});
