import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs helper without type declarations
import { PENDING_LABEL, releasePendingAfterSynchronize } from "../scripts/retarget-stacked-pr-children.mjs";

// #3878 — `release-pending` failed on EVERY fork-head PR.
//
// `releasePendingAfterSynchronize` compared the pull request's head REPOSITORY
// against `expected.repo`, which is `GH_REPO` — the BASE repository. A head repo
// is fixed at PR creation and is the fork for every PR this team opens, so that
// disjunct was unconditionally true for forks and said nothing about whether the
// head had moved. The job threw, and because a red NON-REQUIRED check still
// drives `mergeStateStatus` to UNSTABLE — which `auto-enqueue.yml` excludes from
// its `{CLEAN, HAS_HOOKS}` set — every team PR stranded un-enqueued while
// looking green. Nine needed a manual one-shot enqueue in a single session.
//
// These tests fail against the pre-fix condition with the exact production
// error, `synchronized pull request head changed`.

const BASE_REPO = "loopdive/js2wasm";
const FORK_REPO = "ttraenkler/js2";
const BASE_SHA = "0".repeat(40);

type Side = { ref: string; sha: string; repo: { full_name: string } };
type Pull = {
  number: number;
  state: string;
  labels: { name: string }[];
  head: Side;
  base: Side;
};

function makeForkPull(number: number, headSha: string, labels: string[] = []): Pull {
  return {
    number,
    state: "open",
    labels: labels.map((name) => ({ name })),
    head: { ref: "issue-branch", sha: headSha, repo: { full_name: FORK_REPO } },
    base: { ref: "main", sha: BASE_SHA, repo: { full_name: BASE_REPO } },
  };
}

function harness(pr: Pull) {
  const removed: string[] = [];
  return {
    removed,
    api: {
      getPull: async () => pr,
      // The ancestry proof is exercised by the script's own --self-check; here it
      // is satisfied so the fork-head branch is the only thing under test.
      compare: async () => ({ merge_base_commit: { sha: BASE_SHA } }),
    },
    holdApi: {
      removeIssueLabel: async (_n: number, label: string) => {
        removed.push(label);
        pr.labels = pr.labels.filter((l) => l.name !== label);
      },
    },
  };
}

function expected(number: number, headSha: string) {
  return {
    repo: BASE_REPO,
    number,
    baseRef: "main",
    defaultBranch: "main",
    baseSha: BASE_SHA,
    previousHeadSha: "5".repeat(40),
    headSha,
  };
}

describe("#3878 — release-pending must not fail on fork-head pull requests", () => {
  it("an ordinary fork-head PR reaches the benign no-op instead of throwing", async () => {
    const headSha = "a".repeat(39) + "1";
    const pr = makeForkPull(41, headSha);
    const h = harness(pr);

    // The head SHA matches the synchronize event exactly, so the only thing that
    // could reject this PR is its head being a fork.
    const result = await releasePendingAfterSynchronize({
      api: h.api,
      holdApi: h.holdApi,
      expected: expected(41, headSha),
      log: () => {},
    });

    expect(result).toEqual({ number: 41, released: false });
  });

  it("a fork-head PR holding the pending label RELEASES it (a bare no-op would strand a HOLD_LABELS member)", async () => {
    const headSha = "b".repeat(39) + "2";
    const pr = makeForkPull(42, headSha, [PENDING_LABEL]);
    const h = harness(pr);

    const result = await releasePendingAfterSynchronize({
      api: h.api,
      holdApi: h.holdApi,
      expected: expected(42, headSha),
      log: () => {},
    });

    expect(result).toEqual({ number: 42, released: true });
    expect(h.removed).toContain(PENDING_LABEL);
  });

  it("still throws when the head genuinely moved — on a fork too, so this is not 'skip the check for forks'", async () => {
    const headSha = "b".repeat(39) + "2";
    const pr = makeForkPull(42, headSha, [PENDING_LABEL]);
    const h = harness(pr);

    await expect(
      releasePendingAfterSynchronize({
        api: h.api,
        holdApi: h.holdApi,
        expected: expected(42, "c".repeat(40)),
        log: () => {},
      }),
    ).rejects.toThrow(/head changed/);
  });
});
