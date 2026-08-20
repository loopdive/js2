// #4094 — a PR behind ONLY by `[skip ci]` commits counts as enqueueable.
//
// Stakeholder decision 2026-08-02, breaking the BEHIND-churn loop measured in
// #4093: a `[skip ci]` baseline commit lands on main, every open PR goes BEHIND,
// `ENQUEUEABLE = {CLEAN, HAS_HOOKS}` excludes BEHIND, and green PRs are
// un-enqueueable until a slow refresh cron catches up.
//
// These tests pin the PURE predicates only — no `gh` calls, no queue mutation
// (same style as tests/issue-2560-autoenqueue-trailing-add.test.ts).

import { describe, expect, it } from "vitest";
import {
  SKIP_CI_MARKERS,
  hasSkipCiMarker,
  isSkipCiOnlyDivergence,
  enqueueEligibility,
  divergenceCommitMessages,
  classifyChecks,
  requiredCheckNames,
  REQUIRED_CHECK_FALLBACK,
  authoritativeHeadSha,
  reconcileHeadSha,
  isWorkflowPermissionRefusal,
} from "../scripts/enqueue-green-prs.mjs";

// The real baseline commit that made PR #4002 BEHIND on 2026-08-02 — the exact
// shape this exemption exists for.
const REAL_BASELINE_COMMIT = "chore(test262): refresh sharded baseline — 30780/43490 pass [skip ci]";

describe("#4046 workflow-permission enqueue refusal", () => {
  it("recognises the GitHub App workflow-write refusal", () => {
    expect(
      isWorkflowPermissionRefusal(
        "GraphQL: refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission",
      ),
    ).toBe(true);
    expect(isWorkflowPermissionRefusal("REFUSING TO ALLOW A GITHUB APP TO CREATE OR UPDATE WORKFLOW")).toBe(true);
  });

  it("does not turn unrelated enqueue failures into manual-workflow alerts", () => {
    expect(isWorkflowPermissionRefusal('Required status check "quality" is expected')).toBe(false);
    expect(isWorkflowPermissionRefusal("Pull request is not mergeable")).toBe(false);
    expect(isWorkflowPermissionRefusal(undefined as unknown as string)).toBe(false);
  });
});

describe("#4094 skip-CI marker set", () => {
  // Verified against docs.github.com/.../skip-workflow-runs on 2026-08-02.
  // This repo only ever EMITS `[skip ci]`, so a predicate matching that one
  // spelling would pass every other test here and still be wrong in production.
  it("recognises all five spellings GitHub actually accepts", () => {
    expect([...SKIP_CI_MARKERS].sort()).toEqual(
      ["[actions skip]", "[ci skip]", "[no ci]", "[skip actions]", "[skip ci]"].sort(),
    );
    for (const marker of SKIP_CI_MARKERS) {
      expect(hasSkipCiMarker(`chore: touch up ${marker}`)).toBe(true);
    }
  });

  // GitHub's wording is "add ... to the commit message", not "to the first line".
  it("matches a marker ANYWHERE in the message, not just the subject", () => {
    expect(hasSkipCiMarker("chore: regen artifacts\n\nDetails here.\n[skip ci]")).toBe(true);
    expect(hasSkipCiMarker("chore: regen artifacts\n\n[ci skip] because nothing testable changed")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(hasSkipCiMarker("chore: x [SKIP CI]")).toBe(true);
    expect(hasSkipCiMarker("chore: x [Skip Ci]")).toBe(true);
  });

  it("does not match near-misses or prose about skipping ci", () => {
    expect(hasSkipCiMarker("chore: explain why we skip ci sometimes")).toBe(false); // no brackets
    expect(hasSkipCiMarker("fix: handle [skip] and [ci] separately")).toBe(false);
    expect(hasSkipCiMarker("")).toBe(false);
    expect(hasSkipCiMarker(undefined as unknown as string)).toBe(false);
  });
});

describe("#4094 divergence classification", () => {
  it("POSITIVE CONTROL: divergence of only skip-ci commits is skip-ci-only", () => {
    expect(isSkipCiOnlyDivergence([REAL_BASELINE_COMMIT])).toBe(true);
    expect(isSkipCiOnlyDivergence([REAL_BASELINE_COMMIT, "chore(ci): refresh landing benchmarks [skip ci]"])).toBe(
      true,
    );
  });

  // The load-bearing negative: ONE real commit must sink the whole set.
  it("NEGATIVE CONTROL: one real commit disqualifies the whole divergence", () => {
    expect(isSkipCiOnlyDivergence([REAL_BASELINE_COMMIT, "fix(#1234): change actual codegen"])).toBe(false);
    expect(isSkipCiOnlyDivergence(["fix(#1234): change actual codegen"])).toBe(false);
  });

  // A detector whose "cannot see" answer equals "nothing wrong" is unsound, and
  // this one gates entry to the merge queue. Both blind cases must refuse.
  it("FAILS CLOSED on an EMPTY divergence set (vacuous-truth guard)", () => {
    // `[].every(...)` is true — the trap this guard exists for. A genuinely
    // BEHIND PR is behind by >= 1 commit, so an empty set means we did not see
    // the divergence, not that it was clean.
    expect([].every(() => false)).toBe(true); // documents the JS behaviour being guarded
    expect(isSkipCiOnlyDivergence([])).toBe(false);
  });

  it("FAILS CLOSED on a missing/!array divergence set", () => {
    expect(isSkipCiOnlyDivergence(null as unknown as string[])).toBe(false);
    expect(isSkipCiOnlyDivergence(undefined as unknown as string[])).toBe(false);
    expect(isSkipCiOnlyDivergence("[skip ci]" as unknown as string[])).toBe(false);
  });
});

// The six required contexts, as the ruleset reports them.
const REQUIRED = [
  "cheap gate (main-ancestor + lint)",
  "quality",
  "merge shard reports",
  "equivalence-gate",
  "check for test262 regressions",
  "cla-check",
];
const allGreenRows = () => REQUIRED.map((name) => ({ name, state: "pass" }));

describe("#4094 classifyChecks — required contexts from real check rows", () => {
  it("accepts when every required context is pass or skipping", () => {
    expect(classifyChecks(allGreenRows(), REQUIRED).green).toBe(true);
    // A SKIPPED required check satisfies branch protection.
    const withSkip = allGreenRows().map((r) => (r.name === "equivalence-gate" ? { ...r, state: "skipping" } : r));
    expect(classifyChecks(withSkip, REQUIRED).green).toBe(true);
  });

  // ⚠ A check NAME is not an identifier. `merge shard reports` and `check for
  // test262 regressions` are each published TWICE (real job + #3934 stub) — on
  // PR #4002 one instance read `pass` and the other `skipping`. `head -1` is how
  // a watcher settles on the stub.
  it("handles duplicate names: both instances pass/skipping is green", () => {
    const rows = [...allGreenRows(), { name: "merge shard reports", state: "skipping" }];
    expect(classifyChecks(rows, REQUIRED).green).toBe(true);
  });

  it("handles duplicate names: a FAILING second instance is not masked by a passing first", () => {
    const rows = [...allGreenRows(), { name: "merge shard reports", state: "fail" }];
    const got = classifyChecks(rows, REQUIRED);
    expect(got.green).toBe(false);
    expect(got.failures.join()).toContain("merge shard reports");
  });

  it("handles duplicate names: a PENDING second instance keeps it not-green", () => {
    const rows = [...allGreenRows(), { name: "quality", state: "pending" }];
    expect(classifyChecks(rows, REQUIRED).green).toBe(false);
  });

  // NEGATIVE CONTROL #1 — one red REQUIRED check.
  it("NEGATIVE CONTROL: a red required check is excluded", () => {
    const rows = allGreenRows().map((r) => (r.name === "quality" ? { ...r, state: "fail" } : r));
    expect(classifyChecks(rows, REQUIRED).green).toBe(false);
  });

  // NEGATIVE CONTROL #2 — this is what the UNSTABLE exclusion was protecting
  // (#3878/#3904). Dropping the status string must NOT drop this guard.
  it("NEGATIVE CONTROL: a red NON-required check is also excluded", () => {
    const rows = [...allGreenRows(), { name: "some-optional-canary", state: "fail" }];
    const got = classifyChecks(rows, REQUIRED);
    expect(got.green).toBe(false);
    expect(got.failures.join()).toContain("some-optional-canary");
  });

  it("excludes when a required context never reported at all", () => {
    const rows = allGreenRows().filter((r) => r.name !== "cla-check");
    const got = classifyChecks(rows, REQUIRED);
    expect(got.green).toBe(false);
    expect(got.missingRequired).toContain("cla-check");
  });

  // The reason string must report the OBSERVATION and the discriminator, never a
  // diagnosis. Two mechanisms produce an absent context with OPPOSITE remedies:
  // a dropped `synchronize` delivery (push any commit — what actually happened to
  // #4028 on 2026-08-02) vs a workflow-level `paths:` skip (fix path filters).
  // Asserting the unrecoverable one would send someone editing path filters to
  // chase a GitHub delivery failure.
  it("names the missing contexts and the discriminator, and claims NO cause", () => {
    const rows = allGreenRows().filter((r) => r.name !== "quality");
    const reason = classifyChecks(rows, REQUIRED).reason;
    expect(reason).toContain("quality"); // says WHICH context is absent
    expect(reason).toContain("earlier head"); // gives the discriminator
    expect(reason).toContain("dropped synchronize"); // names the RECOVERABLE case
    // Must not assert the unrecoverable framing.
    expect(reason).not.toMatch(/never be satisfied|permanently|unrecoverable|stranded/i);
  });

  it("FAILS CLOSED on no visible checks", () => {
    expect(classifyChecks([], REQUIRED).green).toBe(false);
    expect(classifyChecks(null as unknown as [], REQUIRED).green).toBe(false);
  });
});

describe("#4094 enqueueEligibility — real signals only", () => {
  const base = { checks: allGreenRows(), requiredNames: REQUIRED, isDraft: false, labels: [], mergeable: "MERGEABLE" };

  // POSITIVE CONTROL: a genuinely-green PR is eligible, and behind-ness is not
  // even an input — #4002 (1 behind) and #4033 (4 behind) were both queued, and
  // #4002 merged with a green merge_group re-validation.
  it("POSITIVE CONTROL: green + mergeable is eligible, with no behindness input", () => {
    const got = enqueueEligibility(base);
    expect(got.eligible).toBe(true);
    expect(got.reason).toBe("real-signals-green");
  });

  // The whole point of the re-scope: the stale field must be unreachable.
  it("does not accept mergeStateStatus as an input at all", () => {
    // Passing it changes nothing — eligibility is decided by real signals.
    expect(enqueueEligibility({ ...base, mergeStateStatus: "BEHIND" } as never).eligible).toBe(true);
    expect(enqueueEligibility({ ...base, mergeStateStatus: "UNSTABLE" } as never).eligible).toBe(true);
    expect(enqueueEligibility({ ...base, mergeStateStatus: "CLEAN" } as never).eligible).toBe(true);
  });

  it("NEGATIVE CONTROL: one red required check stays excluded", () => {
    const checks = allGreenRows().map((r) => (r.name === "quality" ? { ...r, state: "fail" } : r));
    expect(enqueueEligibility({ ...base, checks }).eligible).toBe(false);
  });

  it("NEGATIVE CONTROL: a red NON-required check stays excluded (the #3878/#3904 guard)", () => {
    const checks = [...allGreenRows(), { name: "release-pending", state: "fail" }];
    expect(enqueueEligibility({ ...base, checks }).eligible).toBe(false);
  });

  it("excludes drafts and hold-labelled PRs", () => {
    expect(enqueueEligibility({ ...base, isDraft: true }).eligible).toBe(false);
    expect(enqueueEligibility({ ...base, labels: [{ name: "hold" }] }).eligible).toBe(false);
    expect(enqueueEligibility({ ...base, labels: [{ name: "stack-retarget-pending" }] }).eligible).toBe(false);
  });

  it("excludes CONFLICTING, and fails closed on an UNKNOWN merge computation", () => {
    expect(enqueueEligibility({ ...base, mergeable: "CONFLICTING" }).eligible).toBe(false);
    expect(enqueueEligibility({ ...base, mergeable: "UNKNOWN" }).eligible).toBe(false);
    expect(enqueueEligibility({ ...base, mergeable: undefined }).eligible).toBe(false);
  });
});

describe("#4094 head SHA is sourced from REST, never the cached PR view", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);

  it("reads .head.sha from the REST pull resource", () => {
    const calls: string[][] = [];
    const fake = (args: string[]) => {
      calls.push(args);
      return { ok: true, stdout: `${A}\n`, stderr: "" };
    };
    const got = authoritativeHeadSha(4038, "loopdive/js2wasm", fake);
    expect(got).toEqual({ ok: true, sha: A, reason: "rest" });
    expect(calls[0]!.join(" ")).toContain("repos/loopdive/js2wasm/pulls/4038");
    expect(calls[0]!.join(" ")).toContain(".head.sha");
  });

  // Measured 2026-08-02 on #4028: `gh pr view --json headRefOid` served d07a989e
  // while REST already had e24f4378. Check runs for the stale SHA are all real —
  // green, complete, for the WRONG commit — so the verdict is confidently wrong
  // with no anomaly anywhere. Disagreement must skip, not pick a winner.
  it("PREFERS REST and SKIPS when the cached view disagrees", () => {
    const rest = { ok: true as const, sha: B, reason: "rest" };
    const got = reconcileHeadSha(A, rest);
    expect(got.ok).toBe(false);
    expect(got.reason).toContain("head-sha-stale");
    expect(got.sha).toBe(B); // reports the authoritative one for the log
  });

  it("agrees when the two match", () => {
    expect(reconcileHeadSha(A, { ok: true, sha: A, reason: "rest" })).toEqual({
      ok: true,
      sha: A,
      reason: "head-sha-agreed",
    });
  });

  // Falling back to the cached value on a REST failure would reinstate the bug.
  it("FAILS CLOSED when REST is unreadable — never falls back to the cached SHA", () => {
    const failing = () => ({ ok: false, stdout: "", stderr: "boom" });
    const rest = authoritativeHeadSha(4038, "loopdive/js2wasm", failing);
    expect(rest.ok).toBe(false);
    const got = reconcileHeadSha(A, rest);
    expect(got.ok).toBe(false);
    expect(got.sha).toBeNull();
  });

  it("rejects a non-SHA REST response rather than trusting it", () => {
    const garbage = () => ({ ok: true, stdout: "not-a-sha", stderr: "" });
    expect(authoritativeHeadSha(4038, "loopdive/js2wasm", garbage).ok).toBe(false);
  });
});

describe("#4094 requiredCheckNames", () => {
  it("prefers the live ruleset over the static fallback", () => {
    const fake = () => ({ ok: true, stdout: JSON.stringify(["only-one"]), stderr: "" });
    const got = requiredCheckNames("loopdive/js2wasm", fake);
    expect(got.names).toEqual(["only-one"]);
    expect(got.source).toBe("ruleset");
  });

  // `linear-tests` was documented as required for months and never was (#3934),
  // so the list must come from the ruleset when readable — but a failed read
  // must not yield an EMPTY required set, which would make everything "green".
  it("falls back to the six documented contexts when the ruleset is unreadable", () => {
    const failing = () => ({ ok: false, stdout: "", stderr: "boom" });
    const got = requiredCheckNames("loopdive/js2wasm", failing);
    expect(got.source).toBe("fallback");
    expect(got.names).toEqual([...REQUIRED_CHECK_FALLBACK]);
    expect(got.names.length).toBe(6);
  });

  it("falls back rather than accepting an empty ruleset array", () => {
    const empty = () => ({ ok: true, stdout: "[]", stderr: "" });
    expect(requiredCheckNames("loopdive/js2wasm", empty).source).toBe("fallback");
  });
});

describe("#4094 divergence fetch reads the correct compare field", () => {
  // ⚠ Measured on PR #4002, 2026-08-02: `compare/<head>...main` answered
  // `{ahead_by: 1, behind_by: 16, commits: [<the one [skip ci] commit>]}`.
  // The divergence that matters is `commits` (== ahead_by). Reading `behind_by`
  // — the natural misreading of "how far behind is this PR" — would have called
  // #4002 sixteen commits divergent when it was exactly one baseline refresh.
  it("asks the compare API for .commits[], not behind_by", () => {
    const calls: string[][] = [];
    const fakeGh = (args: string[]) => {
      calls.push(args);
      return { ok: true, stdout: JSON.stringify([REAL_BASELINE_COMMIT]), stderr: "" };
    };
    const got = divergenceCommitMessages("deadbeef", "loopdive/js2wasm", fakeGh);
    expect(got.ok).toBe(true);
    expect(got.messages).toEqual([REAL_BASELINE_COMMIT]);
    const jqArg = calls[0]![calls[0]!.length - 1]!;
    expect(jqArg).toContain(".commits[]");
    expect(jqArg).not.toContain("behind_by");
    expect(calls[0]!.join(" ")).toContain("compare/deadbeef...main");
  });

  it("returns a multi-line message intact so a body-borne marker still matches", () => {
    const multiline = "chore: regen\n\nnothing testable changed\n[ci skip]";
    const fakeGh = () => ({ ok: true, stdout: JSON.stringify([multiline]), stderr: "" });
    const got = divergenceCommitMessages("deadbeef", "loopdive/js2wasm", fakeGh);
    expect(got.messages).toEqual([multiline]);
    expect(isSkipCiOnlyDivergence(got.messages!)).toBe(true);
  });

  it("FAILS CLOSED when the compare call fails or is unparseable", () => {
    const failing = () => ({ ok: false, stdout: "", stderr: "boom" });
    expect(divergenceCommitMessages("deadbeef", "loopdive/js2wasm", failing).ok).toBe(false);
    const garbage = () => ({ ok: true, stdout: "not json", stderr: "" });
    expect(divergenceCommitMessages("deadbeef", "loopdive/js2wasm", garbage).ok).toBe(false);
    const wrongShape = () => ({ ok: true, stdout: JSON.stringify({ commits: 1 }), stderr: "" });
    expect(divergenceCommitMessages("deadbeef", "loopdive/js2wasm", wrongShape).ok).toBe(false);
    expect(divergenceCommitMessages("", "loopdive/js2wasm", failing).ok).toBe(false);
  });
});
