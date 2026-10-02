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

describe("test262 per-edition ratchet — a COMPLETED (100 %) edition allows no regression", () => {
  // Project-lead rule, 2026-09-29: no regression is allowed inside an edition
  // that has reached 100 %. ES5 lost 7 rows between 2026-09-23 and 09-28 while
  // the ratchet reported OK, so these cases assert the gate FIRES.

  it("--update marks an edition completed once every row passes, and keeps it", () => {
    const baseline = join(dir, "completed-seed.json");
    expect(run(["--results", jsonl(allPass(), "completed-seed.jsonl"), "--baseline", baseline, "--update"]).code).toBe(
      0,
    );
    const b = JSON.parse(readFileSync(baseline, "utf-8"));
    expect(b.editions["5"].completed).toBe(true);
    expect(b.editions["2016"].completed).toBe(true);

    // A re-bank keeps the flag: `completed` is sticky.
    expect(run(["--results", jsonl(allPass(), "completed-seed2.jsonl"), "--baseline", baseline, "--update"]).code).toBe(
      0,
    );
    expect(JSON.parse(readFileSync(baseline, "utf-8")).editions["5"].completed).toBe(true);
  });

  it("does NOT mark an edition completed from a partial run", () => {
    const baseline = join(dir, "completed-partial.json");
    const seed = allPass();
    seed[0].status = "fail";
    expect(
      run(["--results", jsonl(seed, "completed-partial-seed.jsonl"), "--baseline", baseline, "--update"]).code,
    ).toBe(0);
    expect(JSON.parse(readFileSync(baseline, "utf-8")).editions["5"].completed).toBeUndefined();

    // Only two of the three ES5 rows, both passing: pass == total for the run,
    // but the run is smaller than the floor, so it is not a completion.
    const partial = allPass().filter((r) => r.file !== ES5_PASS[0]);
    run(["--results", jsonl(partial, "completed-partial.jsonl"), "--baseline", baseline, "--update", "--force"]);
    expect(JSON.parse(readFileSync(baseline, "utf-8")).editions["5"].completed).toBeUndefined();
  });

  it("FAILS on a single non-passing row of a completed edition, even in a PARTIAL run", () => {
    // The count check skips a partially covered edition. The completed check
    // must not: it judges every row the run has.
    const baseline = join(dir, "completed-partial-fail.json");
    run(["--results", jsonl(allPass(), "cpf-seed.jsonl"), "--baseline", baseline, "--update"]);

    const partialWithFail = [{ file: ES5_PASS[0], status: "fail" }];
    const r = run(["--results", jsonl(partialWithFail, "cpf-run.jsonl"), "--baseline", baseline]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("COMPLETED");
    expect(r.out).toContain(ES5_PASS[0]);
  });

  it("FAILS on a count-neutral swap inside a completed edition without --compare", () => {
    // Per-test regressions in a completed edition need no compare baseline:
    // every row must pass, so any non-pass row is the regression.
    const baseline = join(dir, "completed-swap.json");
    run(["--results", jsonl(allPass(), "cs-seed.jsonl"), "--baseline", baseline, "--update"]);
    const b = JSON.parse(readFileSync(baseline, "utf-8"));
    b.editions["5"].pass = 2; // floor below the run, so the COUNT check alone would pass
    writeFileSync(baseline, JSON.stringify(b, null, 2));

    const oneFail = allPass();
    oneFail[1].status = "compile_error";
    const r = run(["--results", jsonl(oneFail, "cs-run.jsonl"), "--baseline", baseline]);
    expect(r.code).toBe(1);
    expect(r.out).toContain(ES5_PASS[1]);
  });

  it("accepts a listed exception, and only that one", () => {
    const baseline = join(dir, "completed-exception.json");
    run(["--results", jsonl(allPass(), "ce-seed.jsonl"), "--baseline", baseline, "--update"]);
    const b = JSON.parse(readFileSync(baseline, "utf-8"));
    b.editions["5"].exceptions = [{ file: ES5_PASS[2], reason: "test: cannot pass on this target by construction" }];
    b.editions["5"].pass = 2;
    writeFileSync(baseline, JSON.stringify(b, null, 2));

    const excepted = allPass();
    excepted[2].status = "fail";
    expect(run(["--results", jsonl(excepted, "ce-ok.jsonl"), "--baseline", baseline]).code).toBe(0);

    const another = allPass();
    another[2].status = "fail";
    another[0].status = "fail";
    const r = run(["--results", jsonl(another, "ce-bad.jsonl"), "--baseline", baseline]);
    expect(r.code).toBe(1);
    expect(r.out).toContain(ES5_PASS[0]);
  });

  it("REFUSES --update while a completed edition has a failing row", () => {
    const baseline = join(dir, "completed-update.json");
    run(["--results", jsonl(allPass(), "cu-seed.jsonl"), "--baseline", baseline, "--update"]);
    const withFail = [...allPass(), { file: "test/language/statements/if/S12.5_A1.2_T1.js", status: "fail" }];
    const r = run(["--results", jsonl(withFail, "cu-run.jsonl"), "--baseline", baseline, "--update"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("COMPLETED");
  });
});

describe("test262 per-edition ratchet — refuses to run blind", () => {
  it("REFUSES (exit 2) when there is no test262 checkout to classify rows", () => {
    // Without test262 every row classifies as "Unclassified (legacy)", every
    // real edition reads NOT COVERED, and the gate would pass having checked
    // nothing — which is how it passed through the 2026-09 ES5 regressions.
    const baseline = join(dir, "blind-baseline.json");
    run(["--results", jsonl(allPass(), "blind-seed.jsonl"), "--baseline", baseline, "--update"]);
    const empty = mkdtempSync(join(tmpdir(), "edition-ratchet-no262-"));
    try {
      const r = (() => {
        try {
          const out = execFileSync(
            TSX,
            [SCRIPT, "--results", jsonl(allPass(), "blind-run.jsonl"), "--baseline", baseline],
            { encoding: "utf-8", stdio: "pipe", env: { ...process.env, EDITION_RATCHET_TEST262_ROOT: empty } },
          );
          return { code: 0, out };
        } catch (e: unknown) {
          const err = e as { status?: number; stdout?: string; stderr?: string };
          return { code: err.status ?? -1, out: (err.stdout ?? "") + (err.stderr ?? "") };
        }
      })();
      expect(r.code).toBe(2);
      expect(r.out).toContain("no test262 checkout");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
