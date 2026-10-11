// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6786 — the js-host lane's per-row gate for COMPLETED editions
 * (`scripts/test262-edition-ratchet.ts --host-lane`).
 *
 * Before this, the host lane had only net gates: `check for test262
 * regressions` hard-fails on net < 0, so a merge with +5 / -4 landed green
 * even when the -4 were ES5 rows. The cases below assert the new gate FAILS
 * where the net gate passes, the way tests/test262-edition-ratchet.test.ts
 * asserts the standalone ratchet fails. A gate with no failing case is a gate
 * that can quietly stop gating.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname ?? ".", "..");
const SCRIPT = join(ROOT, "scripts", "test262-edition-ratchet.ts");
const DIFF = join(ROOT, "scripts", "diff-test262.ts");
const TSX = join(ROOT, "node_modules", ".bin", "tsx");

/** Real test262 paths, so the frontmatter classifier resolves them. */
const ES5 = [
  "test/language/statements/if/S12.5_A1.1_T1.js",
  "test/language/statements/if/S12.5_A1.1_T2.js",
  "test/language/statements/if/S12.5_A1.2_T1.js",
  "test/language/statements/if/S12.5_A1.2_T2.js",
  "test/language/statements/while/S12.6.2_A1.js",
];
const ES2016 = [
  "call-with-boolean.js",
  "fromIndex-equal-or-greater-length-returns-false.js",
  "fromIndex-infinity.js",
  "fromIndex-minus-zero.js",
  "get-prop.js",
  "length-boundaries.js",
  "length-zero-returns-false.js",
  "length.js",
  "name.js",
  "no-arg.js",
  "not-a-constructor.js",
].map((f) => `test/built-ins/Array/prototype/includes/${f}`);

type Row = { file: string; status: string };

let dir: string;
let n = 0;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "edition-ratchet-host-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function file(content: string, ext: string): string {
  const p = join(dir, `f${n++}.${ext}`);
  writeFileSync(p, content);
  return p;
}
const jsonl = (rows: Row[]) => file(rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "jsonl");

/**
 * An edition baseline measured on the STANDALONE target, as the real one is.
 * Only its designations matter on the host lane; its counts are never read.
 */
function editionBaseline(edit: (eds: Record<string, Record<string, unknown>>) => void = () => {}): string {
  const editions: Record<string, Record<string, unknown>> = {
    "5": { ratcheted: true, pass: 5, fail: 0, compile_error: 0, other: 0, total: 5, completed: true },
    "2016": { ratcheted: true, pass: 0, fail: 11, compile_error: 0, other: 0, total: 11 },
  };
  edit(editions);
  return file(
    JSON.stringify({
      generated_at: "2026-10-02T00:00:00.000Z",
      commit: "test",
      target: "standalone",
      eval_engine: "quickjs",
      test262_ref: "test",
      note: "test",
      editions,
    }),
    "json",
  );
}

/** A schema-valid host-noise quarantine (scripts/diff-test262.ts validator) naming one path. */
function quarantine(path: string): string {
  return file(
    JSON.stringify({
      schema_version: 2,
      lane: "js-host",
      policy: {
        eligible_paths: "union-of-complete-same-sha-pool4-canaries",
        intersection_paths: "observed-in-every-recorded-canary",
      },
      provenance: {
        generated_by: "scripts/test262-canary-diff.ts",
        canaries: [
          {
            canary_run_id: 1,
            compiler_sha: "a".repeat(40),
            artifact_id: 1,
            artifact_name: "test262-canary-report",
            compiler_pool_size: 4,
            run_a_entries: 10,
            run_b_entries: 10,
            pass_flips: 1,
            non_pass_status_noise: 0,
            unstable_paths: 1,
          },
        ],
      },
      counts: {
        canary_runs: 1,
        pass_flip_observations: 1,
        non_pass_status_noise_observations: 0,
        union_paths: 1,
        intersection_paths: 1,
      },
      entries: [
        { path, observations: [{ canary_run_id: 1, run_a_status: "pass", run_b_status: "fail", kind: "pass_flip" }] },
      ],
    }),
    "json",
  );
}

interface Run {
  code: number;
  out: string;
}
function exec(script: string, args: string[], env: NodeJS.ProcessEnv = process.env): Run {
  try {
    const out = execFileSync(TSX, [script, ...args], { encoding: "utf-8", stdio: "pipe", env });
    return { code: 0, out };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}
function host(results: string, compare: string | null, baseline: string, extra: string[] = []): Run {
  const args = ["--host-lane", "--results", results, "--baseline", baseline, ...extra];
  if (compare !== null) args.push("--compare", compare);
  return exec(SCRIPT, args);
}

/** Baseline: every ES5 row passes, every ES2016 row fails. */
const baselineRows = (): Row[] => [
  ...ES5.map((f) => ({ file: f, status: "pass" })),
  ...ES2016.map((f) => ({ file: f, status: "fail" })),
];
/** After: ES5[0] broken, all 11 ES2016 rows fixed — net +10. */
const netPlusTen = (): Row[] => [
  { file: ES5[0]!, status: "fail" },
  ...ES5.slice(1).map((f) => ({ file: f, status: "pass" })),
  ...ES2016.map((f) => ({ file: f, status: "pass" })),
];

describe("#6786 — a completed edition allows no pass -> fail on the js-host lane, whatever the net", () => {
  it("FAILS on one ES5 pass -> fail at net +10, a diff the host net gate passes", () => {
    const base = jsonl(baselineRows());
    const after = jsonl(netPlusTen());

    // The gap: the required net gate (diff-test262.ts) accepts this diff.
    const net = exec(DIFF, [base, after, "--quiet"]);
    expect(net.code).toBe(0);
    expect(net.out).toContain("Improvements (other → pass): 11");

    const r = host(after, base, editionBaseline());
    expect(r.code).toBe(1);
    expect(r.out).toContain("COMPLETED");
    expect(r.out).toContain(ES5[0]!);
  });

  it("FAILS on the acceptance case: +5 / -4 inside the completed edition's run", () => {
    const after: Row[] = [
      ...ES5.slice(0, 4).map((f) => ({ file: f, status: "fail" })),
      { file: ES5[4]!, status: "pass" },
      ...ES2016.map((f, i) => ({ file: f, status: i < 5 ? "pass" : "fail" })),
    ];
    const r = host(jsonl(after), jsonl(baselineRows()), editionBaseline());
    expect(r.code).toBe(1);
    expect(r.out).toContain("4 row(s) of a COMPLETED edition");
  });

  it("FAILS on a count-neutral swap inside the completed edition", () => {
    const swapBefore: Row[] = [
      { file: ES5[0]!, status: "pass" },
      { file: ES5[1]!, status: "fail" },
    ];
    const swapAfter: Row[] = [
      { file: ES5[0]!, status: "fail" },
      { file: ES5[1]!, status: "pass" },
    ];
    const r = host(jsonl(swapAfter), jsonl(swapBefore), editionBaseline());
    expect(r.code).toBe(1);
    expect(r.out).toContain(ES5[0]!);
  });

  it("PASSES the same diff when the edition is NOT completed — that is the net gate's business", () => {
    const notCompleted = editionBaseline((eds) => {
      eds["5"]!.completed = undefined;
    });
    const r = host(jsonl(netPlusTen()), jsonl(baselineRows()), notCompleted);
    expect(r.code).toBe(0);
    expect(r.out).toContain("no edition is marked completed");
  });

  it("PASSES when the same flip is in a non-completed edition", () => {
    const base: Row[] = [
      ...ES5.map((f) => ({ file: f, status: "pass" })),
      { file: ES2016[0]!, status: "pass" },
      ...ES2016.slice(1).map((f) => ({ file: f, status: "fail" })),
    ];
    const after: Row[] = [
      ...ES5.map((f) => ({ file: f, status: "pass" })),
      { file: ES2016[0]!, status: "fail" },
      ...ES2016.slice(1).map((f) => ({ file: f, status: "pass" })),
    ];
    const r = host(jsonl(after), jsonl(base), editionBaseline());
    expect(r.code).toBe(0);
    expect(r.out).toContain("OK");
  });

  it("does NOT read the baseline's standalone target or counts on the host lane", () => {
    // The real baseline is target "standalone"; a host run must not be
    // refused for that, and floors far above the run must not fire.
    const highFloors = editionBaseline((eds) => {
      eds["5"]!.pass = 9999;
      eds["5"]!.total = 9999;
    });
    const r = host(jsonl(baselineRows()), jsonl(baselineRows()), highFloors);
    expect(r.code).toBe(0);
  });
});

describe("#6786 — flake classes and exceptions on the js-host lane", () => {
  it("lists a quarantined row's flip but does not gate it", () => {
    const r = host(jsonl(netPlusTen()), jsonl(baselineRows()), editionBaseline(), [
      "--host-noise-quarantine",
      quarantine(ES5[0]!),
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("host noise quarantine");
    expect(r.out).toContain(ES5[0]!);
  });

  it("lists pass -> compile_timeout but does not gate it", () => {
    const after = netPlusTen();
    after[0] = { file: ES5[0]!, status: "compile_timeout" };
    const r = host(jsonl(after), jsonl(baselineRows()), editionBaseline());
    expect(r.code).toBe(0);
    expect(r.out).toContain("compile_timeout");
  });

  it("honours host_exceptions, and only that row", () => {
    const withException = editionBaseline((eds) => {
      eds["5"]!.host_exceptions = [{ file: ES5[0]!, reason: "test: cannot pass on js-host by construction" }];
    });
    expect(host(jsonl(netPlusTen()), jsonl(baselineRows()), withException).code).toBe(0);

    const two = netPlusTen();
    two[1] = { file: ES5[1]!, status: "fail" };
    const r = host(jsonl(two), jsonl(baselineRows()), withException);
    expect(r.code).toBe(1);
    expect(r.out).toContain(ES5[1]!);
  });

  it("does NOT honour the standalone `exceptions` list on the host lane", () => {
    const standaloneOnly = editionBaseline((eds) => {
      eds["5"]!.exceptions = [{ file: ES5[0]!, reason: "test: fails on standalone only" }];
    });
    expect(host(jsonl(netPlusTen()), jsonl(baselineRows()), standaloneOnly).code).toBe(1);
  });

  it("REFUSES a host_exceptions entry without a reason", () => {
    const noReason = editionBaseline((eds) => {
      eds["5"]!.host_exceptions = [{ file: ES5[0]! }];
    });
    const r = host(jsonl(netPlusTen()), jsonl(baselineRows()), noReason);
    expect(r.code).toBe(2);
    expect(r.out).toContain("reason");
  });
});

describe("#6786 — the js-host lane refuses (exit 2) rather than compare nothing", () => {
  it("without --compare", () => {
    const r = host(jsonl(netPlusTen()), null, editionBaseline());
    expect(r.code).toBe(2);
    expect(r.out).toContain("--compare");
  });

  it("when the host baseline jsonl is missing or empty", () => {
    expect(host(jsonl(netPlusTen()), join(dir, "absent.jsonl"), editionBaseline()).code).toBe(2);
    expect(host(jsonl(netPlusTen()), file("", "jsonl"), editionBaseline()).code).toBe(2);
  });

  it("when the host results jsonl is missing or empty", () => {
    expect(host(join(dir, "absent-results.jsonl"), jsonl(baselineRows()), editionBaseline()).code).toBe(2);
    expect(host(file("\n", "jsonl"), jsonl(baselineRows()), editionBaseline()).code).toBe(2);
  });

  it("when the run holds no row of any completed edition", () => {
    const es2016Only = ES2016.map((f) => ({ file: f, status: "pass" }));
    const r = host(jsonl(es2016Only), jsonl(baselineRows()), editionBaseline());
    expect(r.code).toBe(2);
    expect(r.out).toContain("compared nothing");
  });

  it("when the noise quarantine is invalid (it decides what is excused, so it fails closed)", () => {
    const r = host(jsonl(netPlusTen()), jsonl(baselineRows()), editionBaseline(), [
      "--host-noise-quarantine",
      file("{}", "json"),
    ]);
    expect(r.code).toBe(2);
  });

  it("without a test262 checkout to classify rows", () => {
    const empty = mkdtempSync(join(tmpdir(), "edition-ratchet-host-no262-"));
    try {
      const r = exec(
        SCRIPT,
        [
          "--host-lane",
          "--results",
          jsonl(netPlusTen()),
          "--compare",
          jsonl(baselineRows()),
          "--baseline",
          editionBaseline(),
        ],
        { ...process.env, EDITION_RATCHET_TEST262_ROOT: empty },
      );
      expect(r.code).toBe(2);
      expect(r.out).toContain("no test262 checkout");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("and never banks: --update is refused and the baseline is untouched", () => {
    const baseline = editionBaseline();
    const untouched = readFileSync(baseline, "utf-8");
    const r = host(jsonl(baselineRows()), jsonl(baselineRows()), baseline, ["--update"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("banks nothing");
    expect(readFileSync(baseline, "utf-8")).toBe(untouched);
  });
});

describe("#6786 — wired into the required `merge shard reports` check", () => {
  const lines = readFileSync(join(ROOT, ".github", "workflows", "test262-sharded.yml"), "utf-8").split("\n");
  const lineOf = (needle: string) => lines.findIndex((l) => l.includes(needle));
  const block = (nameLine: string) => {
    const start = lineOf(nameLine);
    expect(start, `step not found: ${nameLine}`).toBeGreaterThanOrEqual(0);
    let end = start + 1;
    while (end < lines.length && !/^ {6}- name: /.test(lines[end] ?? "")) end++;
    return lines.slice(start, end).join("\n");
  };
  const GATE = "- name: Host completed-edition per-row gate (#6786)";
  const DEFERRED = '- name: "Fail on host completed-edition breach (deferred, #6786)"';
  const CHECKOUT = "- name: Check out test262 for the edition classifier";

  it("runs the host lane against the host baseline, non-fatal at its own position", () => {
    const b = block(GATE);
    expect(b).toContain("id: host_completed_rows");
    expect(b).toContain("if: env.HOST_RAN == 'true'");
    expect(b).toContain("continue-on-error: true");
    expect(b).toContain("--host-lane");
    expect(b).toContain("--results merged-reports/test262-results-merged.jsonl");
    expect(b).toContain('--compare "$BASE"');
  });

  it("re-raises any failure later, so the required check still blocks the queue", () => {
    const b = block(DEFERRED);
    // continue-on-error rewrites the CONCLUSION; the OUTCOME is the real result.
    expect(b).toContain("steps.host_completed_rows.outcome == 'failure'");
    expect(b).toContain("always()");
    expect(b).toMatch(/exit 1/);
    expect(b).not.toContain("continue-on-error");
    expect(lineOf(DEFERRED)).toBeGreaterThan(lineOf(GATE));
  });

  it("checks test262 out for a host-only merge_group too, before the gate", () => {
    expect(block(CHECKOUT)).toContain("env.HOST_RAN == 'true'");
    expect(lineOf(CHECKOUT)).toBeLessThan(lineOf(GATE));
  });

  it("both halves live in the `merge shard reports` job", () => {
    const job = lineOf("  merge-report:");
    const nextJob = lines.findIndex((l, i) => i > job && /^ {2}[a-z0-9-]+:$/.test(l));
    expect(lineOf(GATE)).toBeGreaterThan(job);
    expect(lineOf(DEFERRED)).toBeLessThan(nextJob);
  });
});
