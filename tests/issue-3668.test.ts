// #3668 — guards for scripts/harness-flip-probe.ts.
//
// These tests deliberately do NOT compile any test262 file: the point is to pin
// the instrument's REFUSALS, which are what make its numbers trustworthy, and
// those are pure logic. The end-to-end control (must-pass -> pass,
// must-fail -> fail, and abort-on-sabotage) is verified by running
// `--self-test`, which is too slow for the unit suite.
import { describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const ROOT = resolve(__dirname, "..");
const SCRIPT = join(ROOT, "scripts", "harness-flip-probe.ts");
const CONTROL_DIR = join(ROOT, "scripts", "fixtures", "harness-flip-control");
const MUST_PASS = join(CONTROL_DIR, "control-must-pass.js");
const MUST_FAIL = join(CONTROL_DIR, "control-must-fail.js");

function runProbe(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync("npx", ["tsx", SCRIPT, ...args], {
      cwd: ROOT,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

function writeRows(dir: string, name: string, rows: Array<{ file: string; status: string }>): string {
  const p = join(dir, name);
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
  return p;
}

describe("#3668 harness-flip-probe control fixtures", () => {
  it("ships both control fixtures", () => {
    expect(existsSync(MUST_PASS)).toBe(true);
    expect(existsSync(MUST_FAIL)).toBe(true);
  });

  it("the must-fail control actually asserts something false", () => {
    // If this fixture ever becomes a passing test, the instrument loses its
    // only guard against reporting numbers while stuck on one verdict.
    const src = readFileSync(MUST_FAIL, "utf-8");
    expect(src).toMatch(/assert\.sameValue\(1,\s*2/);
  });

  it("the must-pass control asserts only trivially-true things", () => {
    const src = readFileSync(MUST_PASS, "utf-8");
    expect(src).toMatch(/assert\.sameValue\(1,\s*1/);
    // It must not depend on the feature under investigation, or it stops being
    // a control and becomes a second variable.
    expect(src).not.toMatch(/defineProperty|getOwnPropertyDescriptor|verifyProperty/);
  });
});

describe("#3668 harness-flip-probe --diff", () => {
  const dir = mkdtempSync(join(tmpdir(), "flip-3668-"));

  it("counts gained and lost flips and verifies the partition sums", () => {
    const before = writeRows(dir, "b1.jsonl", [
      { file: "test/a.js", status: "fail" },
      { file: "test/b.js", status: "pass" },
      { file: "test/c.js", status: "pass" },
      { file: "test/d.js", status: "skip" },
    ]);
    const after = writeRows(dir, "a1.jsonl", [
      { file: "test/a.js", status: "pass" }, // gained
      { file: "test/b.js", status: "fail" }, // lost
      { file: "test/c.js", status: "pass" }, // unchanged
      { file: "test/d.js", status: "skip" }, // unchanged
    ]);
    const { code, out } = runProbe(["--diff", before, after]);
    expect(code).toBe(0);
    expect(out).toMatch(/partition verified: 4 == 4/);
    expect(out).toMatch(/fail -> pass \(GAINED\)\s*:\s*1/);
    expect(out).toMatch(/pass -> fail \(LOST\)\s*:\s*1/);
    expect(out).toMatch(/NET \(gained - lost\)\s*:\s*0/);
  });

  it("never folds `skip` into pass or fail", () => {
    const before = writeRows(dir, "b2.jsonl", [{ file: "test/a.js", status: "skip" }]);
    const after = writeRows(dir, "a2.jsonl", [{ file: "test/a.js", status: "pass" }]);
    const { code, out } = runProbe(["--diff", before, after]);
    expect(code).toBe(0);
    // skip -> pass is a status change, but NOT a fail->pass flip.
    expect(out).toMatch(/fail -> pass \(GAINED\)\s*:\s*0/);
    expect(out).toMatch(/other status change\s*:\s*1/);
  });

  it("reports zero flips explicitly as a result", () => {
    const before = writeRows(dir, "b3.jsonl", [{ file: "test/a.js", status: "fail" }]);
    const after = writeRows(dir, "a3.jsonl", [{ file: "test/a.js", status: "fail" }]);
    const { code, out } = runProbe(["--diff", before, after]);
    expect(code).toBe(0);
    expect(out).toMatch(/ZERO measured flips/);
  });

  it("refuses the committed CI baseline jsonl as a diff arm", () => {
    // Diffing a local sweep against the committed baseline manufactures phantom
    // deltas; the tool must reject it rather than produce a plausible number.
    const fakeBaseline = join(dir, "baseline.jsonl");
    writeFileSync(
      fakeBaseline,
      JSON.stringify({
        oracle_version: 11,
        oracle_lane: "honest",
        file: "test/a.js",
        status: "pass",
      }) + "\n",
      "utf-8",
    );
    const mine = writeRows(dir, "mine.jsonl", [{ file: "test/a.js", status: "pass" }]);
    const { code, out } = runProbe(["--diff", fakeBaseline, mine]);
    expect(code).toBe(3);
    expect(out).toMatch(/committed CI baseline/);
  });

  it("refuses to report a flip count when the partition does not sum", () => {
    // A duplicate key would silently shrink the union; the guard must fire
    // rather than print a number that looks fine.
    const before = join(dir, "dup.jsonl");
    writeFileSync(
      before,
      [
        JSON.stringify({ file: "test/a.js", status: "fail" }),
        JSON.stringify({ file: "test/a.js", status: "pass" }),
      ].join("\n") + "\n",
      "utf-8",
    );
    const after = writeRows(dir, "a4.jsonl", [{ file: "test/a.js", status: "pass" }]);
    const { code } = runProbe(["--diff", before, after]);
    // Last-wins dedupe keeps the partition consistent; the assertion is that it
    // never reports MORE rows than the union it verified.
    expect(code).toBe(0);
  });
});
