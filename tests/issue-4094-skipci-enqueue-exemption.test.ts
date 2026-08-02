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
} from "../scripts/enqueue-green-prs.mjs";

// The real baseline commit that made PR #4002 BEHIND on 2026-08-02 — the exact
// shape this exemption exists for.
const REAL_BASELINE_COMMIT = "chore(test262): refresh sharded baseline — 30780/43490 pass [skip ci]";

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

describe("#4094 enqueue eligibility", () => {
  const skipCiDivergence = { ok: true, messages: [REAL_BASELINE_COMMIT], reason: "commits:1" };
  const realDivergence = { ok: true, messages: ["fix(#1): real change"], reason: "commits:1" };

  it("leaves the pre-existing enqueueable states untouched", () => {
    expect(enqueueEligibility("CLEAN").eligible).toBe(true);
    expect(enqueueEligibility("HAS_HOOKS").eligible).toBe(true);
  });

  // #3878/#3904 — required-green with one red NON-required check is exactly the
  // state that once let red PRs into the queue. It must stay excluded, and must
  // NOT become eligible just because the divergence happens to be skip-ci.
  it("still excludes UNSTABLE, even with a skip-ci-only divergence", () => {
    expect(enqueueEligibility("UNSTABLE").eligible).toBe(false);
    expect(enqueueEligibility("UNSTABLE", skipCiDivergence).eligible).toBe(false);
  });

  it("still excludes DIRTY / BLOCKED / UNKNOWN regardless of divergence", () => {
    for (const state of ["DIRTY", "BLOCKED", "UNKNOWN", "DRAFT"]) {
      expect(enqueueEligibility(state, skipCiDivergence).eligible).toBe(false);
    }
  });

  it("POSITIVE CONTROL: BEHIND by only a skip-ci commit becomes eligible", () => {
    const got = enqueueEligibility("BEHIND", skipCiDivergence);
    expect(got.eligible).toBe(true);
    expect(got.reason).toContain("skip-ci-only");
  });

  it("NEGATIVE CONTROL: BEHIND by a real commit stays excluded", () => {
    expect(enqueueEligibility("BEHIND", realDivergence).eligible).toBe(false);
  });

  it("BEHIND with an unfetched or failed divergence stays excluded", () => {
    expect(enqueueEligibility("BEHIND").eligible).toBe(false);
    expect(enqueueEligibility("BEHIND", null).eligible).toBe(false);
    expect(enqueueEligibility("BEHIND", { ok: false, messages: null, reason: "compare-api-failed" }).eligible).toBe(
      false,
    );
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
    const got = divergenceCommitMessages("deadbeef", "loopdive/js2", fakeGh);
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
    const got = divergenceCommitMessages("deadbeef", "loopdive/js2", fakeGh);
    expect(got.messages).toEqual([multiline]);
    expect(isSkipCiOnlyDivergence(got.messages!)).toBe(true);
  });

  it("FAILS CLOSED when the compare call fails or is unparseable", () => {
    const failing = () => ({ ok: false, stdout: "", stderr: "boom" });
    expect(divergenceCommitMessages("deadbeef", "loopdive/js2", failing).ok).toBe(false);
    const garbage = () => ({ ok: true, stdout: "not json", stderr: "" });
    expect(divergenceCommitMessages("deadbeef", "loopdive/js2", garbage).ok).toBe(false);
    const wrongShape = () => ({ ok: true, stdout: JSON.stringify({ commits: 1 }), stderr: "" });
    expect(divergenceCommitMessages("deadbeef", "loopdive/js2", wrongShape).ok).toBe(false);
    expect(divergenceCommitMessages("", "loopdive/js2", failing).ok).toBe(false);
  });
});
