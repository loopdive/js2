// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1712 — required compiled-Acorn differential acceptance.
 *
 * The child process keeps the ~230 KB Acorn compile out of Vitest's 512 MB
 * worker while still making parser parity a fail-loud default-suite gate. The
 * source and oracle both come from the committed, integrity-checked
 * acorn@8.16.0 tarball; no network access or manually edited package source is
 * involved.
 */
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

describe("#1712 — compiled Acorn differential AST acceptance", () => {
  it("parses the required feature and real-world corpus with exact AST parity", { timeout: 180_000 }, async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", join(HERE, "dogfood", "acorn-corpus.mjs"), "--json"],
      {
        cwd: join(HERE, ".."),
        encoding: "utf-8",
        // The full `real/acorn.mjs` self-parse remains in the canonical
        // dogfood command. Excluding only that 230 KB scale stressor keeps the
        // mandatory per-PR gate near the compile cost while retaining every
        // feature fixture plus both real native-messaging programs.
        env: { ...process.env, ACORN_CORPUS_NO_ACORN_SELF: "1" },
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const report = JSON.parse(stdout);

    expect(report.acornVersion).toBe("8.16.0");
    expect(report.summary).toMatchObject({
      inputs: 22,
      equal: 22,
      equalModuloQuirks: 0,
      realDivergence: 0,
      compiledThrew: 0,
      oracleError: 0,
      distinctRealGaps: 0,
    });
    expect(report.gapMap).toEqual([]);
    expect(
      report.perInput.every(
        (entry: any) =>
          entry.parses === true &&
          entry.structurallyEqual === true &&
          entry.totalDivergences === 0 &&
          entry.quirkCounts &&
          Object.keys(entry.quirkCounts).length === 0,
      ),
    ).toBe(true);
  });
});
