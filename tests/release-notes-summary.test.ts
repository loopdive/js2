// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// `scripts/release.mjs` opens the drafted notes with a summary of the range.
// The counting is pure so it can be pinned here without a git repo or a real
// release — the failure mode being guarded against is a summary that quietly
// miscounts, since nobody re-derives those numbers by hand before shipping.
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs script, no type declarations
import { renderReleaseSummary, summarizeReleaseWork } from "../scripts/release.mjs";

describe("release notes summary", () => {
  it("counts machinery separately instead of listing it", () => {
    const s = summarizeReleaseWork([
      "feat(codegen): #1 real work",
      "chore(test262): scheduled baseline refresh — 32615/43621 pass [skip ci]",
      "chore(ci): refresh landing benchmark artifacts [skip ci]",
      "Merge origin/main into claude/some-branch",
      "Merge branch 'main' into feature",
    ]);

    expect(s.total).toBe(1);
    expect(s.automated).toBe(4);
    expect(s.groups.Features).toEqual(["feat(codegen): #1 real work"]);
  });

  it("keeps a human change that merely carries the skip-ci marker", () => {
    // The filter is `chore(` AND `[skip ci]` for exactly this reason: a real
    // fix tagged skip-ci must not disappear from the notes.
    const s = summarizeReleaseWork([
      "fix(ci): #2 stop double-running the gate [skip ci]",
      "chore(test262): baseline refresh [skip ci]",
    ]);

    expect(s.automated).toBe(1);
    expect(s.groups.Fixes).toEqual(["fix(ci): #2 stop double-running the gate [skip ci]"]);
  });

  it("buckets by conventional-commit type and unwraps PR merge subjects", () => {
    const s = summarizeReleaseWork([
      "Merge pull request #4592 from loopdive/branch feat(ir): #3 adopt computed keys",
      "perf(runtime): #4 fewer boxes",
      "fix(codegen): #5 illegal cast",
      "docs(issues): #6 record the decision",
      "release: v0.70.0",
      "",
    ]);

    expect(s.counts).toEqual({ features: 2, fixes: 1, other: 1 });
    // The release commit itself and blank subjects are neither work nor machinery.
    expect(s.total).toBe(4);
    expect(s.automated).toBe(0);
  });

  it("reads areas from named scopes and ignores issue-number scopes", () => {
    // A third of this repo's subjects put the issue in the scope slot
    // (`fix(#4488): …`), which says nothing about where the change landed.
    const s = summarizeReleaseWork(["fix(codegen): #1 a", "feat(codegen): #2 b", "fix(#4488): c", "fix(ir): #3 d"]);

    expect(s.areas).toEqual([
      ["codegen", 2],
      ["ir", 1],
    ]);
  });

  it("dedupes issue references and orders them numerically", () => {
    const s = summarizeReleaseWork(["fix(a): #30 x", "fix(b): #4 y", "docs(c): #30 again, see #100"]);
    expect(s.issues).toEqual(["#4", "#30", "#100"]);
  });

  it("renders counts, areas and the omitted-machinery tail", () => {
    const text = renderReleaseSummary(
      summarizeReleaseWork([
        "feat(codegen): #1 a",
        "fix(codegen): #2 b",
        "fix(ir): #3 c",
        "chore(test262): refresh [skip ci]",
      ]),
    );

    expect(text).toContain("**3 changes**");
    expect(text).toContain("1 feature, 2 fixes");
    expect(text).toContain("codegen (2)");
    expect(text).toContain("3 issues referenced");
    expect(text).toContain("1 automated baseline/artifact commit omitted");
  });

  it("does not claim work when the range holds only machinery", () => {
    const text = renderReleaseSummary(summarizeReleaseWork(["chore(test262): refresh [skip ci]"]));
    expect(text).toContain("No human-authored changes");
    expect(text).not.toContain("**1 change**");
  });

  it("stays grammatical for a single change", () => {
    const text = renderReleaseSummary(summarizeReleaseWork(["fix(codegen): #1 only one"]));
    expect(text).toContain("**1 change** in this release");
    expect(text).toContain("1 issue referenced");
  });
});
