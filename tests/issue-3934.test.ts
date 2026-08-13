/**
 * #3934 — two CI-truth ratchets.
 *
 * (1) The `test262 PR stub` workflow must not be able to SILENTLY strand a PR.
 *
 *     Measured mechanism (PR #3919, sha 76ec23dc, run 30645425429): the
 *     `detect` job hit its 5-minute budget, GitHub reported the kill as
 *     conclusion `cancelled`, and the PR stranded. NOT because required
 *     contexts went missing — they published as `skipped`, which SATISFIES
 *     branch protection — but because `detect` is itself a check, and a
 *     non-green NON-required check drives mergeStateStatus to UNSTABLE, which
 *     `scripts/enqueue-green-prs.mjs` (ENQUEUEABLE = {CLEAN, HAS_HOOKS})
 *     deliberately excludes. The PR was green on the merits and never enqueued,
 *     with nothing naming the cause.
 *
 *     So "raise the timeout" is not the fix and these tests do not check for
 *     one. They check the two structural properties that make the failure mode
 *     impossible-then-loud:
 *       a. the job budget is UNREACHABLE by ordinary slowness — every fallible
 *          step is individually bounded and continue-on-error, their budgets
 *          sum to less than the job budget, and the verdict step runs under
 *          `if: always()`;
 *       b. if the job dies anyway, the `stub-guard` job PUBLISHES a named
 *          failing check that says so — gated on `!cancelled()` so a real
 *          concurrency cancel (superseded SHA) stays quiet.
 *
 * (2) The documented required-check list must match the LIVE ruleset.
 *     `linear-tests` was documented as required in both CLAUDE.md and
 *     docs/ci-policy.md and is NOT in the ruleset. Re-verify with:
 *
 *       gh api repos/loopdive/js2wasm/rules/branches/main \
 *         --jq '[.[]|select(.type=="required_status_checks")|.parameters.required_status_checks[].context]'
 *
 *     (Enforcement lives in a repo RULESET; the classic
 *     `repos/loopdive/js2wasm/branches/main/protection` endpoint returns 404
 *     "Branch not protected".)
 *
 * Every assertion below is floored — the parse helpers throw rather than
 * return empty, so a broken parse fails loudly instead of vacuously passing.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const STUB_PATH = ".github/workflows/test262-pr-stub.yml";
const SHARDED_PATH = ".github/workflows/test262-sharded.yml";
const STUB = read(STUB_PATH);
const SHARDED = read(SHARDED_PATH);

/**
 * The live required-check set, verified against the ruleset API on 2026-08-01.
 * Six contexts — `linear-tests` is NOT among them.
 */
const REQUIRED_CONTEXTS = [
  "cheap gate (main-ancestor + lint)",
  "merge shard reports",
  "quality",
  "equivalence-gate",
  "check for test262 regressions",
  "cla-check",
] as const;

/** The three of those that `test262-sharded.yml` owns and this stub mirrors. */
const STUB_OWNED_CONTEXTS = [
  "cheap gate (main-ancestor + lint)",
  "merge shard reports",
  "check for test262 regressions",
] as const;

// ---------------------------------------------------------------------------
// Minimal indentation-based YAML slicing. No yaml dependency in this repo, and
// a regex over the whole file would happily "find" nothing and pass; these
// helpers throw instead.
// ---------------------------------------------------------------------------

const stripComments = (block: string) =>
  block
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

/** Slice the top-level `jobs:` mapping into jobId -> raw block text. */
function jobBlocks(yaml: string): Map<string, string> {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start < 0) throw new Error("jobBlocks: no top-level `jobs:` key found");
  const out = new Map<string, string>();
  let cur: string | null = null;
  let buf: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      if (cur) out.set(cur, buf.join("\n"));
      cur = header[1];
      buf = [];
      continue;
    }
    if (line.trim() !== "" && /^\S/.test(line)) break; // dedented out of jobs:
    if (cur) buf.push(line);
  }
  if (cur) out.set(cur, buf.join("\n"));
  if (out.size === 0) throw new Error("jobBlocks: parsed zero jobs");
  return out;
}

/** Value of a `    key:` line at job level (4-space indent), comments ignored. */
function jobAttr(block: string, key: string): string | undefined {
  const m = new RegExp(`^ {4}${key}:[ \\t]*(.*)$`, "m").exec(stripComments(block));
  return m ? m[1].trim() : undefined;
}

/** Split a job block's `steps:` list into raw per-step blocks. */
function stepBlocks(block: string): string[] {
  const lines = stripComments(block).split("\n");
  const start = lines.findIndex((l) => /^ {4}steps:\s*$/.test(l));
  if (start < 0) throw new Error("stepBlocks: no `steps:` key in job block");
  const out: string[] = [];
  let buf: string[] | null = null;
  for (const line of lines.slice(start + 1)) {
    if (/^ {6}- /.test(line)) {
      if (buf) out.push(buf.join("\n"));
      buf = [line];
      continue;
    }
    if (line.trim() !== "" && !/^ {6}/.test(line)) break; // dedented out of steps:
    if (buf) buf.push(line);
  }
  if (buf) out.push(buf.join("\n"));
  if (out.length === 0) throw new Error("stepBlocks: parsed zero steps");
  return out;
}

/**
 * Value of a step-level key. The first key of a step carries the `- ` list
 * marker at 6 spaces; every later key sits at 8. The block is already isolated
 * to one step, so any leading indent is unambiguous.
 */
function stepAttr(step: string, key: string): string | undefined {
  const m = new RegExp(`^ +(?:- )?${key}:[ \\t]*(.*)$`, "m").exec(step);
  return m ? m[1].trim() : undefined;
}

const JOBS = jobBlocks(STUB);

describe("#3934 — the stub's job budget cannot silently strand a PR", () => {
  it("parses the workflow into the five jobs the design relies on", () => {
    expect([...JOBS.keys()].sort()).toEqual(["cheap-gate", "detect", "merge-report", "regression-gate", "stub-guard"]);
  });

  it("detect no longer walks every ref — `fetch-depth: 0` is the cost centre and is gone", () => {
    const detect = JOBS.get("detect")!;
    const checkout = stepBlocks(detect).find((s) => /uses:\s*actions\/checkout/.test(s));
    expect(checkout, "detect must still check out the repo").toBeDefined();
    // fetch-depth 0 fetches all 6,145 refs on this repo (measured: 47.8 s
    // connectivity check) to answer a two-commit question. Depth 2 gives the
    // merge ref's two parents, which IS base-tip..head.
    expect(checkout).not.toMatch(/fetch-depth:\s*0\b/);
    expect(checkout).toMatch(/fetch-depth:\s*2\b/);
  });

  it("every fallible step in detect is individually bounded and non-fatal", () => {
    const detect = JOBS.get("detect")!;
    const steps = stepBlocks(detect);
    expect(steps.length).toBeGreaterThanOrEqual(2);

    const checkout = steps.find((s) => /uses:\s*actions\/checkout/.test(s))!;
    expect(stepAttr(checkout, "continue-on-error")).toBe("true");
    expect(Number(stepAttr(checkout, "timeout-minutes"))).toBeGreaterThan(0);

    // The verdict step must run even when checkout failed or timed out —
    // publishing a verdict is this job's entire contract.
    const verdict = steps.find((s) => /id:\s*detect\b/.test(s));
    expect(verdict, "detect job must have a step with `id: detect`").toBeDefined();
    expect(stepAttr(verdict!, "if")).toBe("always()");
  });

  it("the job budget is a runner-hung backstop, not a work budget", () => {
    const detect = JOBS.get("detect")!;
    const jobBudget = Number(jobAttr(detect, "timeout-minutes"));
    expect(Number.isFinite(jobBudget)).toBe(true);

    const stepBudgets = stepBlocks(detect)
      .map((s) => Number(stepAttr(s, "timeout-minutes")))
      .filter((n) => Number.isFinite(n) && n > 0);
    expect(stepBudgets.length).toBeGreaterThanOrEqual(2);

    // The invariant that makes "detect concluded `cancelled`" unreachable by
    // ordinary slowness: a step budget always trips first, and a tripped step
    // still lets the job publish a verdict and conclude `success`.
    const sum = stepBudgets.reduce((a, b) => a + b, 0);
    expect(sum).toBeLessThan(jobBudget);
  });

  it("detect degrades to the fail-safe instead of aborting", () => {
    const script = JOBS.get("detect")!;
    // `set -e` would abort before the $GITHUB_OUTPUT write.
    expect(script).not.toMatch(/set -euo/);
    expect(script).toMatch(/set -uo pipefail/);
    // Every degrade path must write BOTH outputs and exit 0.
    expect(script).toMatch(/degraded=true/);
    expect(script).toMatch(/stub_required=false/);
    const degradeCalls = script.match(/^\s*degrade "/gm) ?? [];
    expect(degradeCalls.length).toBeGreaterThanOrEqual(4);
  });

  it("stub-guard makes a dead detect LOUD, and stays quiet on a concurrency cancel", () => {
    const guard = JOBS.get("stub-guard")!;

    // MUST be `always()`, not `!cancelled()`. Whether `cancelled()` is true when
    // a job dies to its own `timeout-minutes` is UNMEASURED — and run
    // 30645425429's RUN-level conclusion is `cancelled`, which is at least
    // consistent with it being true. If it is, `!cancelled()` would skip this
    // guard in exactly the case it exists for, and the non-silence guarantee
    // would be empty. `always()` makes the guarantee hold by construction.
    expect(jobAttr(guard, "if")).toBe("${{ always() }}");
    expect(jobAttr(guard, "if")).not.toContain("cancelled()");

    // The cost of always() — also running on a concurrency cancel — must be
    // paid by a DIRECT check (has the PR head moved off this SHA?), not by a
    // status function whose semantics nobody has measured.
    const steps = stepBlocks(guard);
    const supersededStep = steps.find((s) => /id:\s*superseded\b/.test(s));
    expect(supersededStep, "guard must self-suppress on a superseded SHA").toBeDefined();
    expect(supersededStep!).toContain("head.sha");
    // And it must fail loud when it cannot tell: a failed lookup must NOT be
    // treated as "superseded, nothing to see here".
    expect(supersededStep!).toMatch(/-n "\$current"/);

    const needs = jobAttr(guard, "needs")!;
    for (const dep of ["detect", "cheap-gate", "merge-report", "regression-gate"]) {
      expect(needs).toContain(dep);
    }

    // It must actually FAIL — a guard that only logs is not a signal.
    expect(guard).toMatch(/DETECT_RESULT.*!=.*"success"|"\$DETECT_RESULT" != "success"/);
    expect(guard).toMatch(/exit 1/);
    // And it must name the remediation, since a bare `cancelled` names nothing.
    expect(guard).toMatch(/gh run rerun/);
    expect(guard).toMatch(/UNSTABLE/);
  });

  it("the stub's three job names still equal the contexts test262-sharded.yml owns", () => {
    for (const [jobId, ctx] of [
      ["cheap-gate", STUB_OWNED_CONTEXTS[0]],
      ["merge-report", STUB_OWNED_CONTEXTS[1]],
      ["regression-gate", STUB_OWNED_CONTEXTS[2]],
    ] as const) {
      expect(jobAttr(JOBS.get(jobId)!, "name")).toBe(ctx);
      // Same name on the authoritative producer, or the two workflows have
      // drifted and one of them is publishing a context nobody requires.
      expect(SHARDED).toContain(`name: ${ctx}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion #3 of the issue: narrowing the fetch must not change the
// relevance verdict. The verdict is `scripts/test262-paths-match.sh`, which
// MUST mirror test262-sharded.yml's `&test262-paths` allowlist — if the two
// disagree, the stub and the real workflow can both claim, or both drop, a
// required context.
// ---------------------------------------------------------------------------

function anchorPatterns(): string[] {
  const lines = SHARDED.split("\n");
  const start = lines.findIndex((l) => /paths:\s*&test262-paths\s*$/.test(l));
  if (start < 0) throw new Error("anchorPatterns: `paths: &test262-paths` anchor not found");
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const m = /^\s+- "([^"]+)"\s*$/.exec(line);
    if (m) {
      out.push(m[1]);
      continue;
    }
    if (/^\s*#/.test(line) || line.trim() === "") continue;
    break;
  }
  if (out.length === 0) throw new Error("anchorPatterns: parsed zero patterns");
  return out;
}

const matcherVerdict = (path: string): string =>
  execFileSync("bash", ["scripts/test262-paths-match.sh"], {
    cwd: ROOT,
    input: `${path}\n`,
    encoding: "utf8",
  }).trim();

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `&test262-paths` glob -> RegExp (`**` spans slashes, `*` does not). */
const anchorRegex = (pattern: string) =>
  new RegExp(
    `^${pattern
      .split("**")
      .map((part) => part.split("*").map(escapeRe).join("[^/]*"))
      .join(".*")}$`,
  );

/** A concrete path that the pattern should match. */
const samplePath = (pattern: string) => pattern.split("**").join("sample/dir/file.ts").split("*").join("sample");

describe("#3934 — test262-paths-match.sh mirrors the &test262-paths allowlist", () => {
  const patterns = anchorPatterns();

  it("finds the whole allowlist, not a truncated slice", () => {
    // Floor the count: a silently-empty parse must not read as "all patterns agree".
    expect(patterns.length).toBeGreaterThanOrEqual(18);
    expect(patterns).toContain("src/**");
    expect(patterns).toContain(SHARDED_PATH);
  });

  it.each(patterns)("allowlisted pattern %s is test262-relevant to the matcher", (pattern) => {
    const path = samplePath(pattern);
    expect(anchorRegex(pattern).test(path), `sample ${path} must match its own pattern`).toBe(true);
    expect(matcherVerdict(path)).toBe("true");
  });

  // Both sides must agree these are IRRELEVANT. The first five are the files
  // this very PR touches: they put this PR on the path-excluded arm, which is
  // what makes its own CI run the live demonstration of the stub's green arm.
  const excluded = [
    STUB_PATH,
    "tests/issue-3934.test.ts",
    "docs/ci-policy.md",
    "CLAUDE.md",
    "plan/issues/3934-test262-pr-stub-5min-timeout-drops-required-contexts.md",
    "README.md",
    ".github/workflows/ci.yml",
  ];

  it.each(excluded)("non-allowlisted path %s is irrelevant on BOTH sides", (path) => {
    const matched = patterns.filter((p) => anchorRegex(p).test(path));
    expect(matched, `${path} unexpectedly matches allowlist pattern(s)`).toEqual([]);
    expect(matcherVerdict(path)).toBe("false");
  });
});

// ---------------------------------------------------------------------------
// The docs drift that caused wrong calls: `linear-tests` documented as required
// when the ruleset has six contexts without it.
// ---------------------------------------------------------------------------

/** Context names in a markdown table whose first column is `` `name` ``. */
function tableContexts(section: string): string[] {
  const out: string[] = [];
  for (const line of section.split("\n")) {
    const m = /^\|\s*`([^`]+)`\s*\|/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

function section(md: string, heading: string, nextHeadingRe: RegExp): string {
  const start = md.indexOf(heading);
  if (start < 0) throw new Error(`section: heading not found: ${heading}`);
  const rest = md.slice(start + heading.length);
  const m = nextHeadingRe.exec(rest);
  return rest.slice(0, m ? m.index : undefined);
}

describe("#3934 — the documented required-check list matches the live ruleset", () => {
  const policy = read("docs/ci-policy.md");
  const claudeMd = read("CLAUDE.md");
  const RECHECK =
    "re-verify with: gh api repos/loopdive/js2wasm/rules/branches/main --jq '[.[]|select(.type==\"required_status_checks\")|.parameters.required_status_checks[].context]'";

  it("§1 required-checks table lists exactly the six required contexts", () => {
    const listed = tableContexts(section(policy, "### Required-checks list", /^### /m));
    expect(listed.length).toBeGreaterThan(0); // floor: a failed slice must not pass
    expect([...listed].sort(), RECHECK).toEqual([...REQUIRED_CONTEXTS].sort());
  });

  it("§7 mapping table lists exactly the six required contexts", () => {
    const listed = tableContexts(section(policy, "## 7. Mapping: required check", /^## /m));
    expect(listed.length).toBeGreaterThan(0);
    expect([...listed].sort(), RECHECK).toEqual([...REQUIRED_CONTEXTS].sort());
  });

  it("`linear-tests` is documented as NOT required", () => {
    // It still runs (ci.yml) and is still worth listing — just not as required.
    const optional = section(policy, "### Optional / informational checks", /^---/m);
    expect(optional).toContain("`linear-tests`");
  });

  it("every prose enumeration of the required list in CLAUDE.md is the same six", () => {
    // Lines that enumerate the list are identifiable by carrying both ends of it.
    const enumerations = claudeMd
      .split("\n")
      .filter((l) => l.includes("cheap gate (main-ancestor + lint)") && l.includes("cla-check"));
    expect(enumerations.length, "no required-check enumeration found in CLAUDE.md").toBeGreaterThan(0);
    for (const line of enumerations) {
      for (const ctx of REQUIRED_CONTEXTS) expect(line, RECHECK).toContain(ctx);
      // `linear-tests` may appear on such a line ONLY to say it is not
      // required — naming the correction helps a reader more than omitting it.
      if (line.includes("`linear-tests`")) {
        expect(line, `CLAUDE.md must not present linear-tests as required. ${RECHECK}`).toMatch(
          /`linear-tests` is NOT required/,
        );
      }
    }
  });

  it("both documents carry the verification command inline", () => {
    for (const [name, text] of [
      ["docs/ci-policy.md", policy],
      ["CLAUDE.md", claudeMd],
    ] as const) {
      expect(text, `${name} must tell the reader how to re-check the ruleset`).toContain("rules/branches/main");
    }
  });

  it("records that a SKIPPED required check satisfies the requirement", () => {
    // The fact that made people misread green PRs: counting six SUCCESS
    // conclusions in statusCheckRollup does not find them on a docs-only PR.
    expect(policy.toLowerCase()).toContain("skipped");
    expect(policy).toMatch(/skipped[\s\S]{0,400}satisf/i);
  });

  it("records that auto-refresh-prs skips drafts", () => {
    expect(policy).toMatch(/draft/i);
    expect(policy).toMatch(/auto-refresh-prs[\s\S]{0,400}draft/i);
  });
});
