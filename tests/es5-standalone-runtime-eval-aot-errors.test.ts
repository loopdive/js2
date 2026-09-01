// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { selectCachedRuntimeEvalProvider } from "../scripts/runtime-eval-provider.mjs";

const execFileAsync = promisify(execFile);

const REGRESSION_FILES = [
  "test/built-ins/Function/15.3.5.4_2-8gs.js",
  "test/built-ins/Function/15.3.5.4_2-10gs.js",
  "test/built-ins/Function/15.3.5.4_2-13gs.js",
] as const;

let liveQuickjsAvailable = false;
try {
  liveQuickjsAvailable =
    existsSync(resolve("test262", REGRESSION_FILES[0])) && selectCachedRuntimeEvalProvider().engine === "quickjs";
} catch {
  liveQuickjsAvailable = false;
}

describe.skipIf(!liveQuickjsAvailable)("ES5 runtime-eval AOT abrupt completion", () => {
  for (const file of REGRESSION_FILES) {
    it(file, { timeout: 120_000 }, async () => {
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "--max-old-space-size=2048",
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          `import { resolve } from "node:path";
           import { runTest262File } from "./tests/test262-runner.ts";
           const file = process.env.JS2WASM_ES5_AOT_ERROR_FILE;
           const result = await runTest262File(resolve("test262", file), "es5-runtime-eval-aot-errors", 120000, "standalone");
           console.log(JSON.stringify({ status: result.status, error: result.error ?? "" }));`,
        ],
        {
          cwd: resolve("."),
          encoding: "utf8",
          env: { ...process.env, JS2WASM_ES5_AOT_ERROR_FILE: file },
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as { status?: string; error?: string };
      expect(result.status, result.error).toBe("pass");
    });
  }
});
