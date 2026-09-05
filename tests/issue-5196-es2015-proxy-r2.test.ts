// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #5196 — Standalone Proxy revocation functions return the canonical
 * `undefined` carrier, not the null externref sentinel.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildImports, compile, instantiateWasm } from "../src/index.js";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";
import { runTest262File } from "./test262-runner.js";

type Lane = "host" | "standalone";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEST262_ROOT = join(REPO_ROOT, "test262");
const TIMEOUT_MS = 180_000;
const RUNNER_TIMEOUT_MS = 120_000;
const TEST262_AVAILABLE = existsSync(join(TEST262_ROOT, "harness", "assert.js"));
const test262It = TEST262_AVAILABLE ? it : it.skip;

const EXACT_RETURN_ROWS = [
  "built-ins/Proxy/revocable/revoke-returns-undefined.js",
  "built-ins/Proxy/revocable/revoke-consecutive-call-returns-undefined.js",
] as const;
const PASSING_CONTROL = "built-ins/Proxy/revocable/revoke.js";

const CONTROL_SOURCE = `
  export function test(): number {
    const pair: any = Proxy.revocable({ value: 17 }, {});
    if (pair.proxy.value !== 17) return 1;

    const first: any = pair.revoke();
    if (first !== undefined) return 2;
    if (first === null) return 3;

    const second: any = pair.revoke();
    if (second !== undefined) return 4;
    if (second === null) return 5;

    try {
      pair.proxy.value;
      return 6;
    } catch (error) {
      if (!(error instanceof TypeError)) return 7;
    }
    return 0;
  }
`;

async function runControl(lane: Lane): Promise<{ value: number; imports: string[] }> {
  const result = await compile(CONTROL_SOURCE, {
    allowJs: true,
    fileName: "issue-5196-es2015-proxy-r2.ts",
    skipSemanticDiagnostics: true,
    ...(lane === "standalone" ? { target: "standalone" as const } : {}),
  });
  expect(
    result.success,
    `${lane} control compile failed:\n${result.errors?.map((error) => `L${error.line}: ${error.message}`).join("\n") ?? ""}`,
  ).toBe(true);
  if (!result.success) return { value: -1, imports: [] };

  const module = await WebAssembly.compile(result.binary);
  const imports = WebAssembly.Module.imports(module).map((entry) => `${entry.module}::${entry.name}`);
  if (lane === "standalone") {
    expect(imports, "standalone revocation controls must emit zero imports").toEqual([]);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    return { value: (instance.exports as { test: () => number }).test(), imports };
  }

  const built = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, built.env, built.string_constants);
  built.setInstance?.(instance);
  return { value: (instance.exports as { test: () => number }).test(), imports };
}

describe("#5196 ES2015 standalone Proxy revoker return", () => {
  for (const lane of ["host", "standalone"] as const) {
    it(
      `${lane}: revoker returns undefined twice, preserves null distinction, and revokes the proxy`,
      { timeout: TIMEOUT_MS },
      async () => {
        const outcome = await runControl(lane);
        expect(outcome.value).toBe(0);
        if (lane === "standalone") expect(outcome.imports).toEqual([]);
      },
    );
  }

  for (const relativePath of [...EXACT_RETURN_ROWS, PASSING_CONTROL]) {
    const filePath = join(TEST262_ROOT, "test", relativePath);
    test262It(`standalone exact Test262 row: ${relativePath}`, { timeout: TIMEOUT_MS }, async () => {
      try {
        const result = await runTest262File(filePath, "issue-5196-standalone", RUNNER_TIMEOUT_MS, "standalone");
        expect(result.status, `${relativePath}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
      } finally {
        restoreHostBuiltins();
      }
    });
  }
});
