// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1712 / #2847 — standalone Acorn artifact acceptance.
 *
 * This intentionally runs outside the Vitest worker with a 3 GB heap. The
 * combined parser graph exceeds the normal 512 MB fork before reaching a
 * semantic compile verdict, so testing it in-process would make memory limits
 * indistinguishable from compiler failures.
 */
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

describe("#1712 — standalone compiled Acorn acceptance", () => {
  it("emits a valid host-free parser module with a callable parse export", { timeout: 1_200_000 }, async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--max-old-space-size=3072", "--import", "tsx", join(HERE, "dogfood", "acorn-standalone-compile.mjs")],
      {
        cwd: join(HERE, ".."),
        encoding: "utf-8",
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const report = JSON.parse(stdout);

    expect(report.acornVersion).toBe("8.16.0");
    expect(report.errors).toEqual([]);
    expect(report.success).toBe(true);
    expect(report.binaryBytes).toBeGreaterThan(0);
    expect(report.functionImports).toEqual([]);
    expect(report.exports).toContain("parse");
    expect(report.exports).toContain("parseExpressionAt");
    expect(report.exports).toContain("tokenizer");
    expect(report.runtimeCanary).toBe(2);
    expect(report.parseExpressionAtCanary).toBe(3);
    expect(report.tokenizerCanary).toBe(4);
    expect(report.functionBodyCanaryError).toBeNull();
    expect(report.functionBodyCanary).toBe(5);
  });
});
