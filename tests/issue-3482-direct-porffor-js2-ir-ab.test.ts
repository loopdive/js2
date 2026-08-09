// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { PORFFOR_IR_COMMIT } from "../src/ir/backend/porffor/compat.js";
import {
  PORFFOR_DIRECT_AB_EXPECTED_CHECKSUM,
  PORFFOR_DIRECT_AB_EXPECTED_FIXED,
  PORFFOR_DIRECT_AB_EXPECTED_SANITIZER_CHECKSUM,
  PORFFOR_DIRECT_AB_FIXTURE,
  PORFFOR_DIRECT_AB_FIXED_SEEDS,
  PORFFOR_DIRECT_AB_ROWS,
  checksumForIterations,
  quartiles,
  readExactSource,
} from "../scripts/lib/porffor-direct-ab.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(repoRoot, PORFFOR_DIRECT_AB_FIXTURE);
const porfforRoot = resolve(repoRoot, "vendor/Porffor");
const nativeRequired = process.env.PORFFOR_DIRECT_AB_REQUIRED === "1";
const nativeAvailable =
  existsSync(join(porfforRoot, "porf")) &&
  spawnSync("clang", ["--version"], { cwd: repoRoot, stdio: "ignore" }).status === 0 &&
  spawnSync("git", ["-C", porfforRoot, "rev-parse", "HEAD"], { cwd: repoRoot, stdio: "ignore" }).status === 0;
const nativeIt = nativeAvailable || nativeRequired ? it : it.skip;
const temporaryRoot = mkdtempSync(join(tmpdir(), "js2-3482-"));
const configuredOutput = process.env.PORFFOR_DIRECT_AB_TEST_OUTPUT;
const matrixOutput = configuredOutput ? resolve(repoRoot, configuredOutput) : join(temporaryRoot, "sanitizer-matrix");

afterAll(() => {
  rmSync(temporaryRoot, { recursive: true, force: true });
});

describe("#3482 direct Porffor / JS2 source A/B", () => {
  it("pins one exact TypeScript byte sequence and its semantic oracle", () => {
    const source = readExactSource(sourcePath);
    expect(source.sha256).toBe("b140de2b6e1f012da594cc62336e74a1e1b39ef484eb3d30f221a392b5b1235d");
    expect(source.bytes).toBe(249);
    expect(PORFFOR_DIRECT_AB_FIXED_SEEDS).toEqual([-7, 0, 4, 31]);
    expect(PORFFOR_DIRECT_AB_EXPECTED_FIXED).toEqual([-535, 235, 675, 3645]);
    expect(checksumForIterations(200_000)).toBe(PORFFOR_DIRECT_AB_EXPECTED_CHECKSUM);
    expect(checksumForIterations(20_000)).toBe(PORFFOR_DIRECT_AB_EXPECTED_SANITIZER_CHECKSUM);
  });

  it("uses R-7 quartiles for the 21-sample summaries", () => {
    expect(quartiles(Array.from({ length: 21 }, (_, index) => index + 1))).toEqual({
      q1: 6,
      median: 11,
      q3: 16,
    });
  });

  nativeIt("runs the exact pinned direct Porffor C command model", () => {
    if (!nativeAvailable) throw new Error("PORFFOR_DIRECT_AB_REQUIRED=1 but pinned Porffor or clang is unavailable");
    const actualCommit = execFileSync("git", ["-C", porfforRoot, "rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    expect(actualCommit).toBe(PORFFOR_IR_COMMIT);
    const output = join(temporaryRoot, "direct-cli.c");
    execFileSync(join(porfforRoot, "porf"), ["c", "--module", "-O1", sourcePath, output], {
      cwd: repoRoot,
      stdio: "pipe",
    });
    expect(statSync(output).size).toBeGreaterThan(0);
    expect(readFileSync(output, "utf8")).toContain("int main(");
  });

  nativeIt(
    "records plain direct Porffor's expected UBSan failure and requires both JS2 rows clean",
    () => {
      if (!nativeAvailable) throw new Error("PORFFOR_DIRECT_AB_REQUIRED=1 but pinned Porffor or clang is unavailable");
      rmSync(matrixOutput, { recursive: true, force: true });
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/benchmark-porffor-direct-ab.mts",
          "--mode",
          "sanitize",
          "--warmup-rounds",
          "0",
          "--measured-rounds",
          "1",
          "--iterations",
          "20000",
          "--allow-dirty",
          "--output",
          matrixOutput,
        ],
        { cwd: repoRoot, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

      const latestPath = join(matrixOutput, "latest.json");
      const latest = JSON.parse(readFileSync(latestPath, "utf8")) as {
        capture: { mode: string };
        fixture: { sha256: string };
        rows: Array<{
          id: string;
          artifacts: { renderedCSha256: string };
          safety: { sanitizerExpectation: string; performanceAuthority: string };
          samples: Array<{
            verdict: string;
            processStatus: number;
            diagnosticKind: string | null;
            diagnosticLine: string | null;
            checksumDecimal: string | null;
            fixedOutputs: number[] | null;
            iterationsAttempted: number;
          }>;
        }>;
      };
      expect(latest.capture.mode).toBe("sanitize");
      expect(latest.fixture.sha256).toBe("b140de2b6e1f012da594cc62336e74a1e1b39ef484eb3d30f221a392b5b1235d");
      expect(latest.rows.map((row) => row.id)).toEqual(PORFFOR_DIRECT_AB_ROWS);
      for (const row of latest.rows) {
        expect(row.samples).toHaveLength(1);
        const sample = row.samples[0]!;
        const representative = join(matrixOutput, "representative", row.id, "rendered.c");
        expect(existsSync(representative)).toBe(true);
        expect(sample.iterationsAttempted).toBe(20_000);
        expect(createHash("sha256").update(readFileSync(representative)).digest("hex")).toBe(
          row.artifacts.renderedCSha256,
        );
        if (row.id.startsWith("direct-porffor-")) {
          expect(row.safety).toMatchObject({
            sanitizerExpectation: "misaligned-object-entry-ubsan",
            performanceAuthority: "ub-contaminated-non-authoritative",
          });
          expect(sample).toMatchObject({
            verdict: "expected-ubsan-failure",
            diagnosticKind: "misaligned-dynamic-object-f64",
            checksumDecimal: null,
            fixedOutputs: null,
          });
          expect(sample.processStatus).not.toBe(0);
          expect(sample.diagnosticLine).toContain("misaligned address");
          const plainC = readFileSync(representative, "utf8");
          expect(plainC.match(/\*\(f64\*\)\(MEM \+ entryPtr \+ 8u\)/g)).toHaveLength(4);
          expect(plainC).not.toContain("porf_store_un_f64(MEM + entryPtr + 8u");
          expect(plainC).not.toContain("porf_load_un_f64(MEM + entryPtr + 8u");
        } else {
          expect(row.safety).toMatchObject({
            sanitizerExpectation: "clean",
            performanceAuthority: "within-machine-informational",
          });
          expect(sample).toMatchObject({
            verdict: "clean",
            processStatus: 0,
            diagnosticKind: null,
            diagnosticLine: null,
            checksumDecimal: String(PORFFOR_DIRECT_AB_EXPECTED_SANITIZER_CHECKSUM),
            fixedOutputs: [...PORFFOR_DIRECT_AB_EXPECTED_FIXED],
          });
        }
        expect(existsSync(join(matrixOutput, "representative", row.id, "lane.c"))).toBe(true);
      }

      const validation = spawnSync(
        process.execPath,
        ["--import", "tsx", "scripts/benchmark-porffor-direct-ab.mts", "--validate-result", latestPath],
        { cwd: repoRoot, encoding: "utf8" },
      );
      expect(validation.status, `${validation.stdout}\n${validation.stderr}`).toBe(0);
    },
    180_000,
  );
});
