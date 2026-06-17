import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

function writeJsonl(path: string, records: Record<string, unknown>[]) {
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
}

function readJsonl(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function runHeal(inPath: string, outPath: string): string {
  return execFileSync("npx", ["tsx", "scripts/heal-poison-rows.ts", "--in", inPath, "--out", outPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// Real test262 files that compile + pass under the current compiler — used so
// the clean-process re-run produces a real `pass` verdict for the healed row.
const PASSING_TEST = "test/language/types/boolean/S8.3_A1_T1.js";

describe("#2099 promote-baseline heals poison-classified rows", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  function paths() {
    tmpDir = mkdtempSync(join(tmpdir(), "issue-2099-"));
    return { in: join(tmpDir, "merged.jsonl"), out: join(tmpDir, "healed.jsonl") };
  }

  it("re-runs a phantom Binary-emit-error row and heals it to its true verdict", () => {
    const p = paths();
    writeJsonl(p.in, [
      {
        file: PASSING_TEST,
        category: "language",
        status: "compile_error",
        error: "Binary emit error: offset is out of bounds",
        oracle_version: 1,
      },
    ]);
    runHeal(p.in, p.out);
    const rows = readJsonl(p.out);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pass");
    expect(rows[0]!.error).toBeUndefined();
    expect(rows[0]!.poison_healed).toBe(true);
  });

  it("passes non-poison rows through byte-for-byte", () => {
    const p = paths();
    const passRow = { file: "test/a.js", category: "language", status: "pass", oracle_version: 1 };
    const realFail = {
      file: "test/b.js",
      category: "language",
      status: "fail",
      error: "assertion failed: expected 1 got 2",
      oracle_version: 1,
    };
    writeJsonl(p.in, [passRow, realFail]);
    runHeal(p.in, p.out);
    const rows = readJsonl(p.out);
    expect(rows).toEqual([passRow, realFail]);
  });

  it("reports nothing-to-heal when no poison rows are present", () => {
    const p = paths();
    writeJsonl(p.in, [{ file: "test/a.js", category: "language", status: "pass", oracle_version: 1 }]);
    const out = runHeal(p.in, p.out);
    expect(out).toMatch(/no poison-classified rows/i);
    expect(readJsonl(p.out)).toHaveLength(1);
  });

  it("does not treat a pass/skip row as poison even if its error text matches", () => {
    // Defensive: a pass row should never carry a poison error, but if a stray
    // field exists the row must not be re-run / mutated.
    const p = paths();
    const row = {
      file: PASSING_TEST,
      category: "language",
      status: "pass",
      error: "Binary emit error (stale field)",
      oracle_version: 1,
    };
    writeJsonl(p.in, [row]);
    const out = runHeal(p.in, p.out);
    expect(out).toMatch(/no poison-classified rows/i);
    expect(readJsonl(p.out)).toEqual([row]);
  });
});
