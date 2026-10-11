// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6783) scripts/known-failures-gate.mjs turns the ~4,400 root test files
// into a required ratchet: the files red on main are the baseline, a file
// that goes green → red fails, a baseline file that goes green is "newly
// fixed" and leaves the baseline post-merge. These cases drive the gate over
// vitest-shaped file entries and shard partials — no vitest run, no git — and
// assert it FAILS where it should as well as passing the clean control.
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeSummaries } from "../scripts/equivalence-gate.mjs";
import {
  bankKnownFailures,
  classifyEntry,
  collectAllowances,
  makeToRel,
  mergeKnownPartials,
  parseAllowItem,
  scoreKnownFailures,
  shardSlice,
} from "../scripts/known-failures-gate.mjs";
import { parseFrontmatterList } from "../scripts/lib/change-scope.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GATE = join(REPO_ROOT, "scripts", "known-failures-gate.mjs");
const CI_ROOT = "/ci/checkout";
const toRel = makeToRel(REPO_ROOT);
const SHA = "a".repeat(40);

type Assertion = { fullName: string; status: string; failureMessages?: string[] };
type Entry = { name: string; status: string; message: string; assertionResults: Assertion[] };

function entry(file: string, tests: Record<string, string>, opts: { status?: string; message?: string } = {}): Entry {
  const assertionResults = Object.entries(tests).map(([fullName, status]) => ({
    fullName,
    status,
    failureMessages: status === "unexpected" ? ["Error: Expect test to fail"] : [],
  }));
  for (const a of assertionResults) if (a.status === "unexpected") a.status = "failed";
  const failed = assertionResults.some((a) => a.status === "failed");
  return {
    name: `${CI_ROOT}/${file}`,
    status: opts.status ?? (failed ? "failed" : "passed"),
    message: opts.message ?? "",
    assertionResults,
  };
}

/** A shard partial exactly as the shard step writes it. */
function partial(shard: string, entries: Entry[], extra: { expected?: string[]; sha?: string } = {}) {
  const parts = entries.map((e) => classifyEntry(e, toRel));
  const s = mergeSummaries(parts.map((p) => p.summary));
  return {
    format: "known-failures/1",
    suite: "issue-tests",
    sha: extra.sha ?? SHA,
    shard,
    failing: [...s.failing].sort(),
    passing: [...s.passing].sort(),
    files: [...s.files].sort(),
    fileFailures: s.fileFailures,
    unexplained: s.unexplained,
    expected: extra.expected ?? entries.map((e) => toRel(e.name)).sort(),
    unexpectedPasses: parts.flatMap((p) => p.unexpected).sort(),
    flakes: [],
  };
}

const A = "tests/issue-1-a.test.ts";
const B = "tests/issue-2-b.test.ts";
const C = "tests/ir/c.test.ts";
const D = "tests/issue-4-d.test.ts";
const POPULATION = [A, B, C, D];

/** Main today: A green, B red (one assertion), C green, D red (import error). */
function mainShards() {
  return [
    partial("1/2", [entry(A, { "a one": "passed" }), entry(B, { "b ok": "passed", "b broken": "failed" })]),
    partial("2/2", [
      entry(C, { "c ok": "passed" }),
      entry(D, {}, { status: "failed", message: "Cannot find module './gone.js'" }),
    ]),
  ];
}

function score(partials: ReturnType<typeof partial>[], known: string[] | null, allow = new Map()) {
  const m = mergeKnownPartials(partials, "issue-tests");
  return scoreKnownFailures(m.summary, {
    known,
    expected: m.expected,
    diskFiles: POPULATION,
    allow,
    unexpectedPasses: m.unexpectedPasses,
  });
}

// --- CLI harness: a throwaway "repo" with only the test files, no git -----

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function fakeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "kf-gate-"));
  tmpDirs.push(root);
  for (const f of POPULATION) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), "// fixture\n");
  }
  return root;
}

/** The gate's environment minus every GIT_* variable, so no git state leaks in or out. */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const drop = new Set(["SHARD", "KNOWN_FAILURES_ALLOW_BASE", "KNOWN_FAILURES_BASELINE", "KNOWN_FAILURES_ONLY"]);
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_") && !drop.has(k)) env[k] = v;
  return { ...env, ...extra };
}

function runCli(root: string, partials: object[], args: string[] = []) {
  const dir = join(root, "partials");
  mkdirSync(dir, { recursive: true });
  partials.forEach((p, i) => writeFileSync(join(dir, `p${i}.json`), JSON.stringify(p)));
  const r = spawnSync(process.execPath, [GATE, "--suite", "issue-tests", ...args], {
    cwd: root,
    encoding: "utf8",
    env: cleanEnv({ KNOWN_FAILURES_ROOT: root, MERGE_PARTIALS_DIR: dir }),
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const baselinePath = (root: string) => join(root, "scripts", "issue-tests-baseline.json");
function writeKnown(root: string, knownFailures: string[]) {
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(baselinePath(root), JSON.stringify({ suite: "issue-tests", measuredAt: SHA, knownFailures }));
}

describe("#6783 known-failures gate — seed mode", () => {
  it("with no baseline it scores nothing, exits 0 and prints the red list as the proposed baseline", () => {
    const root = fakeRepo();
    const r = runCli(root, mainShards());
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("SEED MODE");
    expect(r.out).toContain(`Proposed scripts/issue-tests-baseline.json (2 red file(s))`);
    expect(r.out).toContain(`${B} — test failed: b broken`);
    expect(r.out).toContain(`${D} — no tests collected: Cannot find module './gone.js'`);
    expect(existsSync(baselinePath(root)), "seed mode must not write without --seed-if-missing").toBe(false);
  });

  it("--update-on-decrease alone does not seed; --seed-if-missing writes the red list measured at the run's commit", () => {
    const root = fakeRepo();
    expect(runCli(root, mainShards(), ["--update-on-decrease"]).status).toBe(0);
    expect(existsSync(baselinePath(root))).toBe(false);
    const r = runCli(root, mainShards(), ["--update-on-decrease", "--seed-if-missing"]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("SEEDED");
    const written = JSON.parse(readFileSync(baselinePath(root), "utf8"));
    expect(written).toMatchObject({ suite: "issue-tests", measuredAt: SHA, knownFailures: [D, B].sort() });
  });

  it("refuses to seed from a run with an unexpected pass (#3340) — the sentinel must be promoted first", () => {
    const root = fakeRepo();
    const shards = mainShards();
    shards[0] = partial("1/2", [
      entry(A, { "a one": "passed", "a sentinel": "unexpected" }),
      entry(B, { "b ok": "passed", "b broken": "failed" }),
    ]);
    const r = runCli(root, shards, ["--update-on-decrease", "--seed-if-missing"]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("bank REFUSED");
    expect(r.out).toContain(`UNEXPECTED PASS: ${A} :: a sentinel`);
    expect(existsSync(baselinePath(root))).toBe(false);
  });
});

describe("#6783 known-failures gate — enforce mode", () => {
  it("control: main's own red set against its baseline passes", () => {
    const v = score(mainShards(), [B, D]);
    expect(v).toMatchObject({ ok: true, regressions: [], newlyFixed: [], integrityFailures: [], unexplained: [] });
  });

  it("a green file that goes red fails and is named (assertion failure)", () => {
    const shards = mainShards();
    shards[0] = partial("1/2", [entry(A, { "a one": "failed" }), entry(B, { "b ok": "passed", "b broken": "failed" })]);
    const v = score(shards, [B, D]);
    expect(v.ok).toBe(false);
    expect(v.regressions).toEqual([A]);
    expect(v.files.reasons.get(A)).toBe("test failed: a one");
  });

  it("a green file that stops importing fails too — a file-level failure is a red file, not a silent zero", () => {
    const shards = mainShards();
    shards[1] = partial("2/2", [
      entry(C, {}, { status: "failed", message: "Transform failed with 1 error" }),
      entry(D, {}, { status: "failed", message: "Cannot find module './gone.js'" }),
    ]);
    const v = score(shards, [B, D]);
    expect(v.ok).toBe(false);
    expect(v.regressions).toEqual([C]);
  });

  it("a baseline file that now passes is reported newly fixed, and the gate stays green", () => {
    const shards = mainShards();
    shards[0] = partial("1/2", [entry(A, { "a one": "passed" }), entry(B, { "b ok": "passed", "b broken": "passed" })]);
    const v = score(shards, [B, D]);
    expect(v.ok).toBe(true);
    expect(v.newlyFixed).toEqual([B]);
    const r = runCli(
      (() => {
        const root = fakeRepo();
        writeKnown(root, [B, D]);
        return root;
      })(),
      shards,
    );
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(`fixed: ${B}`);
  });

  it("CLI: green → red exits 1 with REGRESSION and the allowance recipe", () => {
    const root = fakeRepo();
    writeKnown(root, [B, D]);
    const shards = mainShards();
    shards[1] = partial("2/2", [
      entry(C, { "c ok": "failed" }),
      entry(D, {}, { status: "failed", message: "Cannot find module './gone.js'" }),
    ]);
    const r = runCli(root, shards);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`REGRESSION: ${C} — test failed: c ok`);
    expect(r.out).toContain("known-failures-allow:");
  });

  it("an unexpected pass fails even in a baseline file (#3340)", () => {
    const shards = mainShards();
    shards[0] = partial("1/2", [
      entry(A, { "a one": "passed" }),
      entry(B, { "b broken": "failed", "b sentinel": "unexpected" }),
    ]);
    const v = score(shards, [B, D]);
    expect(v.ok).toBe(false);
    expect(v.regressions).toEqual([]);
    expect(v.unexpected).toEqual([`${B} :: b sentinel`]);
  });

  it("a missing shard partial fails the gate (CLI)", () => {
    const root = fakeRepo();
    writeKnown(root, [B, D]);
    const r = runCli(root, [mainShards()[0]]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("RUN FAILURE: no partial for shard 2/2");
    expect(r.out).toContain(`RUN FAILURE: ${C} — on disk but absent from the report (never run)`);
  });

  it("a duplicated shard, or partials measured at different commits, fail the gate", () => {
    const [one, two] = mainShards();
    expect(score([one, one, two], [B, D]).unexplained).toContain("two partials claim shard 1/2");
    const other = partial("2/2", [entry(C, { "c ok": "passed" })], { sha: "b".repeat(40), expected: [C, D] });
    const v = score([one, other], [B, D]);
    expect(v.ok).toBe(false);
    expect(v.unexplained.join("\n")).toContain("partials were measured at different commits");
    // D was expected by its shard but never reported — a lost file, not a red one.
    expect(v.integrityFailures).toContainEqual({ file: D, reason: "expected by its shard but absent from the report" });
  });
});

describe("#6783 known-failures gate — allowances (never by editing the baseline)", () => {
  const frontmatter = [
    "---",
    "id: 9999",
    "known-failures-allow:",
    `  - "${A} 2026-10-02 asserts the pre-#9999 shape; rewritten in #10000"`,
    `  - "${C} no date, no grant"`,
    "---",
    "body",
  ].join("\n");

  it("parses path + ISO date + reason; an item missing the date or reason grants nothing", () => {
    expect(parseAllowItem(`${A} 2026-10-02 stale assertion`)).toEqual({
      path: A,
      date: "2026-10-02",
      reason: "stale assertion",
    });
    expect(parseAllowItem(`${A} — 2026-10-02: stale assertion`)?.reason).toBe("stale assertion");
    expect(parseAllowItem(`${A} 2026-10-02`)).toBeNull();
    expect(parseAllowItem(`${A} stale assertion`)).toBeNull();
    const items = parseFrontmatterList(frontmatter, "known-failures-allow");
    const { allow, invalid } = collectAllowances(new Map(items.map((i) => [i, ["plan/issues/9999-x.md"]])));
    expect([...allow.keys()]).toEqual([A]);
    expect(invalid.map((i) => i.item)).toEqual([`${C} no date, no grant`]);
  });

  it("an allowed green → red file passes the gate and is banked as known; an unallowed one is not", () => {
    const shards = mainShards();
    shards[0] = partial("1/2", [entry(A, { "a one": "failed" }), entry(B, { "b ok": "passed", "b broken": "failed" })]);
    const items = parseFrontmatterList(frontmatter, "known-failures-allow");
    const { allow } = collectAllowances(new Map(items.map((i) => [i, ["plan/issues/9999-x.md"]])));
    const v = score(shards, [B, D], allow);
    expect(v.ok).toBe(true);
    expect(v.allowed.map((a) => a.file)).toEqual([A]);
    expect(bankKnownFailures(v, { knownFailures: [B, D] })).toEqual({ knownFailures: [A, B, D].sort(), refusals: [] });

    const unallowed = score(shards, [B, D]);
    expect(unallowed.ok).toBe(false);
    // Decrease-only: an unexcused red file is never banked into the baseline.
    expect(bankKnownFailures(unallowed, { knownFailures: [B, D] }).knownFailures).toEqual([B, D].sort());
  });
});

describe("#6783 known-failures gate — the post-merge bank", () => {
  it("drops newly fixed and deleted files, keeps the rest (CLI)", () => {
    const root = fakeRepo();
    writeKnown(root, [B, D, "tests/issue-gone.test.ts"]);
    const shards = mainShards();
    shards[0] = partial("1/2", [entry(A, { "a one": "passed" }), entry(B, { "b ok": "passed", "b broken": "passed" })]);
    const r = runCli(root, shards, ["--update-on-decrease", "--seed-if-missing"]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("gone: tests/issue-gone.test.ts");
    expect(JSON.parse(readFileSync(baselinePath(root), "utf8")).knownFailures).toEqual([D]);
  });

  it("refuses to bank a run with a file-level failure no result carries (a file lost from its shard)", () => {
    const root = fakeRepo();
    writeKnown(root, [B, D]);
    const shards = mainShards();
    // The shard was asked for C and D; only D reached the report.
    shards[1] = partial("2/2", [entry(D, {}, { status: "failed", message: "Cannot find module" })], {
      expected: [C, D],
    });
    const before = readFileSync(baselinePath(root), "utf8");
    const r = runCli(root, shards, ["--update-on-decrease"]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("bank REFUSED");
    expect(r.out).toContain(`${C}: expected by its shard but absent from the report`);
    expect(readFileSync(baselinePath(root), "utf8")).toBe(before);
  });

  it("refuses to bank when a shard partial is missing", () => {
    const v = score([mainShards()[0]], [B, D]);
    const bank = bankKnownFailures(v, { knownFailures: [B, D] });
    expect(bank.refusals.join("\n")).toContain("no partial for shard 2/2");
  });
});

describe("#6783 known-failures gate — sharding", () => {
  it("round-robin shards cover the population exactly once", () => {
    const files = Array.from({ length: 23 }, (_, i) => `tests/f${String(i).padStart(2, "0")}.test.ts`);
    const slices = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => shardSlice(files, `${i}/8`));
    expect(slices.flat().sort()).toEqual(files);
    expect(Math.max(...slices.map((s) => s.length)) - Math.min(...slices.map((s) => s.length))).toBeLessThanOrEqual(1);
    expect(() => shardSlice(files, "9/8")).toThrow(/bad SHARD/);
  });
});
