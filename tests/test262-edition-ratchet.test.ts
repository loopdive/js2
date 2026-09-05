/**
 * Tests for the per-edition conformance ratchet (scripts/test262-edition-ratchet.ts).
 *
 * A gate with no test is a gate that can silently stop gating. This repo has
 * already been bitten by exactly that: #3953 records a high-water floor that sat
 * 475 tests too low for 37 consecutive merges, reporting "passed" the whole time
 * — because a floor that is too low never fires, and nothing tested that it
 * still could. So the cases below assert the ratchet FAILS when it should, not
 * just that it passes when it should.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = join(import.meta.dirname ?? ".", "..", "scripts", "test262-edition-ratchet.ts");
const TSX = join(import.meta.dirname ?? ".", "..", "node_modules", ".bin", "tsx");

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "edition-ratchet-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Real test262 paths, so the script's frontmatter classifier resolves them. */
const ES5_PASS = [
  "test/language/statements/if/S12.5_A1.1_T1.js",
  "test/language/statements/for/S12.6.3_A1.js",
  "test/language/statements/while/S12.6.2_A1.js",
];
const ES2016_PASS = [
  "test/built-ins/Array/prototype/includes/length.js",
  "test/built-ins/Array/prototype/includes/name.js",
];

function jsonl(rows: { file: string; status: string }[], nameOfFile: string): string {
  const p = join(dir, nameOfFile);
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}

interface Run {
  code: number;
  out: string;
}
function run(args: string[]): Run {
  try {
    const out = execFileSync(TSX, [SCRIPT, ...args], { encoding: "utf-8", stdio: "pipe" });
    return { code: 0, out };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

const allPass = () => [...ES5_PASS, ...ES2016_PASS].map((file) => ({ file, status: "pass" }));

describe("test262 per-edition ratchet", () => {
  it("seeds a baseline, then accepts an identical run", () => {
    const results = jsonl(allPass(), "seed.jsonl");
    const baseline = join(dir, "seed-baseline.json");

    const seeded = run(["--results", results, "--baseline", baseline, "--update"]);
    expect(seeded.code).toBe(0);

    const written = JSON.parse(readFileSync(baseline, "utf-8"));
    // Every edition is ratcheted by DEFAULT — a ratchet that only guards the
    // editions someone remembered to list is not a ratchet.
    expect(written.editions["5"].ratcheted).toBe(true);
    expect(written.editions["5"].pass).toBe(ES5_PASS.length);
    expect(written.editions["2016"].pass).toBe(ES2016_PASS.length);

    expect(run(["--results", results, "--baseline", baseline]).code).toBe(0);
  });

  it("FAILS when a ratcheted edition loses passes", () => {
    const baseline = join(dir, "count-baseline.json");
    run(["--results", jsonl(allPass(), "count-base.jsonl"), "--baseline", baseline, "--update"]);

    const regressed = allPass();
    regressed[0].status = "fail"; // an ES5 test
    const r = run(["--results", jsonl(regressed, "count-bad.jsonl"), "--baseline", baseline]);

    expect(r.code).toBe(1);
    expect(r.out).toContain("ES5");
    expect(r.out).toContain("FAILED");
  });

  it("FAILS on a count-NEUTRAL swap: one test broken, another fixed", () => {
    // This is the case a count-only ratchet cannot see, and the reason the
    // per-test check exists. The edition total is identical either side.
    const before = [
      { file: ES5_PASS[0]!, status: "pass" },
      { file: ES5_PASS[1]!, status: "fail" },
      { file: ES5_PASS[2]!, status: "pass" },
    ];
    const after = [
      { file: ES5_PASS[0]!, status: "fail" }, // broken
      { file: ES5_PASS[1]!, status: "pass" }, // fixed
      { file: ES5_PASS[2]!, status: "pass" },
    ];
    const beforePath = jsonl(before, "swap-before.jsonl");
    const afterPath = jsonl(after, "swap-after.jsonl");

    const baseline = join(dir, "swap-baseline.json");
    run(["--results", beforePath, "--baseline", baseline, "--update"]);

    const counts = run(["--results", afterPath, "--baseline", baseline]);
    expect(counts.code).toBe(0); // counts alone see nothing wrong — 2 pass either way

    const perTest = run(["--results", afterPath, "--baseline", baseline, "--compare", beforePath]);
    expect(perTest.code).toBe(1);
    expect(perTest.out).toContain(ES5_PASS[0]!);
  });

  it("does NOT gate an edition explicitly opted out", () => {
    const baseline = join(dir, "optout-baseline.json");
    run(["--results", jsonl(allPass(), "optout-base.jsonl"), "--baseline", baseline, "--update"]);

    const b = JSON.parse(readFileSync(baseline, "utf-8"));
    b.editions["5"].ratcheted = false;
    b.editions["5"].reason = "test: deliberately un-ratcheted";
    writeFileSync(baseline, JSON.stringify(b, null, 2));

    const regressed = allPass();
    regressed[0].status = "fail";
    const r = run(["--results", jsonl(regressed, "optout-bad.jsonl"), "--baseline", baseline]);

    expect(r.code).toBe(0);
    expect(r.out).toContain("not ratcheted");
  });

  it("SKIPS a partially-covered edition instead of scoring it", () => {
    // A path-filtered or sharded run sees only some of an edition's tests. Its
    // pass count is not a measurement, and must not read as a collapse.
    const baseline = join(dir, "partial-baseline.json");
    run(["--results", jsonl(allPass(), "partial-base.jsonl"), "--baseline", baseline, "--update"]);

    const partial = [{ file: ES5_PASS[0]!, status: "pass" }]; // 1 of 3 ES5 rows
    const r = run(["--results", jsonl(partial, "partial.jsonl"), "--baseline", baseline]);

    expect(r.code).toBe(0);
    expect(r.out).toContain("NOT COVERED");
  });

  it("REFUSES to bank a baseline from a partial run", () => {
    // Otherwise a scoped run silently lowers the bar — the #4412 hazard.
    const baseline = join(dir, "nobank-baseline.json");
    run(["--results", jsonl(allPass(), "nobank-base.jsonl"), "--baseline", baseline, "--update"]);
    const untouched = readFileSync(baseline, "utf-8");

    const partial = [{ file: ES5_PASS[0]!, status: "pass" }];
    const r = run(["--results", jsonl(partial, "nobank.jsonl"), "--baseline", baseline, "--update"]);

    expect(r.code).toBe(2);
    expect(r.out).toContain("REFUSED");
    expect(readFileSync(baseline, "utf-8")).toBe(untouched);
  });

  it("REFUSES to bank a regression, so --update cannot be used to go green", () => {
    const baseline = join(dir, "nolower-baseline.json");
    run(["--results", jsonl(allPass(), "nolower-base.jsonl"), "--baseline", baseline, "--update"]);
    const untouched = readFileSync(baseline, "utf-8");

    const regressed = allPass();
    regressed[0].status = "fail";
    const r = run(["--results", jsonl(regressed, "nolower.jsonl"), "--baseline", baseline, "--update"]);

    expect(r.code).toBe(1);
    expect(r.out).toContain("REFUSED to update");
    expect(readFileSync(baseline, "utf-8")).toBe(untouched);
  });

  it("REFUSES to compare across targets, whose pass counts are not comparable", () => {
    const baseline = join(dir, "target-baseline.json");
    run([
      "--results",
      jsonl(allPass(), "target-base.jsonl"),
      "--baseline",
      baseline,
      "--target",
      "standalone",
      "--update",
    ]);

    const r = run(["--results", jsonl(allPass(), "target-gc.jsonl"), "--baseline", baseline, "--target", "gc"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("REFUSED");
  });

  it("banks an improvement", () => {
    const baseline = join(dir, "improve-baseline.json");
    const worse = allPass();
    worse[0].status = "fail";
    run(["--results", jsonl(worse, "improve-base.jsonl"), "--baseline", baseline, "--update"]);
    expect(JSON.parse(readFileSync(baseline, "utf-8")).editions["5"].pass).toBe(ES5_PASS.length - 1);

    const r = run(["--results", jsonl(allPass(), "improve-after.jsonl"), "--baseline", baseline, "--update"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(baseline, "utf-8")).editions["5"].pass).toBe(ES5_PASS.length);
  });
});

describe("test262 per-edition ratchet — ungated editions are reported, not hidden", () => {
  it("names an edition the run measured but the baseline never heard of", () => {
    // The failure mode this guards is silence: a new edition, or a baseline
    // seeded from a narrower run than the one being checked, sitting outside
    // the ratchet with nothing saying so.
    const dir2 = mkdtempSync(join(tmpdir(), "edition-ratchet-ungated-"));
    try {
      const es5Only = ES5_PASS.map((file) => ({ file, status: "pass" }));
      const seedPath = join(dir2, "es5-only.jsonl");
      writeFileSync(seedPath, es5Only.map((r) => JSON.stringify(r)).join("\n") + "\n");

      const baseline = join(dir2, "baseline.json");
      expect(run(["--results", seedPath, "--baseline", baseline, "--update"]).code).toBe(0);
      expect(JSON.parse(readFileSync(baseline, "utf-8")).editions["2016"]).toBeUndefined();

      // Now check a run that ALSO covers ES2016, which the baseline lacks.
      const wider = [...es5Only, ...ES2016_PASS.map((file) => ({ file, status: "pass" }))];
      const widerPath = join(dir2, "wider.jsonl");
      writeFileSync(widerPath, wider.map((r) => JSON.stringify(r)).join("\n") + "\n");

      const r = run(["--results", widerPath, "--baseline", baseline]);
      expect(r.code).toBe(0); // ungated is a warning, not a failure
      expect(r.out).toContain("UNGATED");
      expect(r.out).toContain("ES2016");
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});
