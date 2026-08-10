// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The npm-compat refresh promotes through a PULL REQUEST, never a direct push
 * to main.
 *
 * WHY THIS FILE STILL EXISTS UNDER THE #4130 NAME. #4130 was "the staleness
 * floor in the merge-queue gate measures the wrong artifact, so a busy queue
 * defers the promotion forever". The fix pinned the step ORDER that fed the
 * floor. That whole mechanism is now GONE: the gate, `--stale-after-hours` and
 * the fail-open branch existed only to make a DIRECT push to main survivable,
 * and a PR does not push to main. Rather than delete the file and lose the
 * history of what this workflow keeps getting wrong, it now pins the shape of
 * the replacement.
 *
 * THE BUG BEING PREVENTED (2026-08-09): any push to main — INCLUDING a
 * `[skip ci]` one — makes GitHub rebuild every in-flight `merge_group` and
 * discard the ~19-minute `Test262 Sharded` job running under it. PR #4323's
 * group started 22:52 on f70b4eb2, this workflow's auto-commit landed 22:59:30,
 * the group was rebuilt at 22:59:51. #4297 lost three windows the same day.
 *
 * The assertions are structural raw-text pins (matching
 * `ci-quality-failfast.test.ts`): the repo carries no YAML parser, and step
 * order / step wiring is a property of the file's text anyway. When this breaks
 * there is no output to assert on — the workflow goes green and the damage
 * lands on somebody else's PR.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const workflow = readFileSync(resolve(ROOT, ".github/workflows/npm-compat-refresh.yml"), "utf8");

const at = (needle: string): number => workflow.indexOf(needle);

/**
 * The workflow's comments deliberately NAME the things that must not happen
 * ("HEAD:main", "[skip ci]", the gate script) so the next reader learns why
 * they are absent. Assert against executable lines only — both YAML comments
 * and shell comments inside `run:` blocks start with `#` after indentation.
 */
const code = workflow
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

describe("npm-compat promotion never pushes to main", () => {
  it("has no `HEAD:main` push anywhere in the workflow", () => {
    // The single assertion that matters. `main-push-queue-gate.mjs` exists to
    // make such a push survivable; removing the push removes the need for a
    // gate, a staleness floor, and a fail-open branch all at once.
    expect(code).not.toContain("HEAD:main");
    expect(code).not.toMatch(/git push[^\n]*\bmain\b(?!-)/);
  });

  it("does not call the merge-queue gate any more", () => {
    // The script itself must STAY — `benchmark-refresh.yml` and
    // `refresh-baseline.yml` still push to main directly and still call it.
    // That is asserted by the class-coverage test in
    // tests/issue-3915-main-push-queue-gate.test.ts; here we only assert that
    // THIS path stopped calling it.
    expect(code).not.toContain("main-push-queue-gate.mjs");
    expect(code).not.toContain("--stale-after-hours");
    // A vestigial `if:` on a deleted step evaluates to empty and silently
    // enables the step it was meant to guard.
    expect(code).not.toContain("steps.queue_gate");
    expect(code).not.toContain("steps.committed");
  });

  it("pushes the artifacts to ONE reused promotion branch", () => {
    expect(workflow).toMatch(/PROMOTION_BRANCH:\s*\S+/);
    const promote = workflow.slice(at("- name: Publish the refreshed artifacts"));
    expect(promote).toMatch(/git push[^\n]*--force[^\n]*refs\/heads\/\$\{PROMOTION_BRANCH\}/);
  });

  it("opens a PR only when none is open, so artifact PRs coalesce", () => {
    const create = workflow.slice(at("- name: Open the promotion PR"));
    expect(create).toContain("gh pr create");
    // Guarded on "no PR number found" — a queue of stale artifact PRs would be
    // worse than the problem being fixed.
    expect(workflow).toMatch(
      /if:\s*steps\.promote\.outputs\.published == '1' && steps\.queue_state\.outputs\.pr_number == ''/,
    );
  });

  it("does not enqueue — auto-enqueue.yml is the single enqueuer (#2786)", () => {
    expect(workflow).not.toContain("enqueuePullRequest");
    expect(workflow).not.toContain("gh pr merge");
  });
});

describe("the promotion commit must be visible to CI", () => {
  it("drops [skip ci] from the artifact commit", () => {
    // The PR now NEEDS its checks to run in order to reach `CLEAN` and be
    // picked up by auto-enqueue. `[skip ci]` would leave it permanently
    // unmergeable — and it is also what broke the Pages redeploy (#4217).
    expect(code).not.toContain("[skip ci]");
  });

  it("still commits and pushes with --no-verify (#4132/#4140)", () => {
    // This job runs `pnpm install`, so husky's hooks are live and neither can
    // do its job here (fetch-depth 1, persist-credentials false, no
    // origin/main). Unrelated to the PR switch; still required.
    const promote = workflow.slice(at("- name: Publish the refreshed artifacts"));
    expect(promote).toMatch(/git commit[^\n]*--no-verify/);
    expect(promote).toMatch(/git push[^\n]*--no-verify/);
  });

  it("opens the PR with a non-GITHUB_TOKEN actor", () => {
    // A PR created with GITHUB_TOKEN fires no pull_request /
    // pull_request_target events, so it gets neither CI nor cla-check, never
    // reaches CLEAN, and strands forever looking healthy. Same rule that
    // wedged the merge queue in #2523.
    expect(workflow).toContain("actions/create-github-app-token@v3");
    const create = workflow.slice(at("- name: Open the promotion PR"));
    expect(create).toContain("steps.app-token.outputs.token");
    expect(create).not.toContain("secrets.GITHUB_TOKEN");
  });
});

describe("the refresh cannot retrigger itself", () => {
  it("ignores pushes that only change the npm-compat artifacts", () => {
    // Both old loop-breakers are gone with the direct push: no `[skip ci]`, and
    // the landing commit's actor is the merge queue rather than
    // `github-actions[bot]`. Perf numbers differ on every run, so every run
    // publishes — without this filter each landing would trigger the next
    // refresh forever.
    expect(workflow).toContain("paths-ignore:");
    for (const p of [
      "benchmarks/results/npm-compat.json",
      "benchmarks/results/npm-compat-perf.json",
      "benchmarks/results/npm-compat-history.json",
      "website/public/benchmarks/results/npm-compat.json",
      "website/public/benchmarks/results/npm-compat-perf.json",
      "website/public/benchmarks/results/npm-compat-history.json",
    ]) {
      expect(workflow.slice(at("paths-ignore:"), at("  # Backstop for a quiet main"))).toContain(p);
    }
  });

  it("does not force-update the branch while its PR is in the merge queue", () => {
    // Force-pushing the head of the in-flight merge group rebuilds it and
    // cancels its run — the exact harm this change removes, relocated.
    const gate = workflow.slice(
      at("- name: Check whether the promotion PR"),
      at("- name: Publish the refreshed artifacts"),
    );
    expect(gate).toContain("mergeQueue");
    // ...but an unreadable queue must PROCEED, never freeze the artifact.
    // That is #4130's lesson and it survives the redesign.
    expect(gate).toMatch(/skip=0[^\n]*GITHUB_OUTPUT[\s\S]*?;;\s*$/m);
    expect(gate).toContain("must never freeze the artifact");
  });
});

describe("the pre-promote sanity check is unrelated to the PR switch and stays", () => {
  it("still refuses to publish fewer than 20 packages or entries missing name/compile", () => {
    const check = workflow.slice(
      at("- name: Sanity-check the generated artifact"),
      at("- name: Upload generated artifacts"),
    );
    expect(check).toContain("packages.length < 20");
    expect(check).toContain("entry.name && entry.compile");
    expect(check).toContain("refusing to publish");
  });

  it("runs BEFORE anything is pushed", () => {
    expect(at("- name: Sanity-check the generated artifact")).toBeLessThan(
      at("- name: Publish the refreshed artifacts"),
    );
  });
});

describe("the promotion PR must survive auto-enqueue's author-trust gate", () => {
  // Without this the whole change is inert in the worst possible way: the PR
  // opens, goes green, and is skipped `untrusted-author:…` on every sweep. A
  // skip is silent, so the only symptom is a dashboard that stops moving.
  const autoEnqueue = readFileSync(resolve(ROOT, ".github/workflows/auto-enqueue.yml"), "utf8");

  it("allowlists the app that opens the PR, derived from the minted token", () => {
    // An app's authorAssociation is not OWNER/MEMBER/COLLABORATOR, its login is
    // not `ttraenkler`, and the promotion branch's head repo owner is
    // `loopdive` rather than the fork — so none of the gate's three layers
    // match by default.
    expect(autoEnqueue).toContain("TRUSTED_AUTHOR_LOGINS:");
    expect(autoEnqueue).toContain("${{ steps.app-token.outputs.app-slug }}[bot]");
    // Hardcoding a login would drift from whichever app actually mints the
    // token; deriving it cannot.
    expect(autoEnqueue).not.toMatch(/TRUSTED_AUTHOR_LOGINS:[^\n]*merge-queue-bot\[bot\]/);
  });

  it("keeps the existing maintainer login (the env REPLACES the default)", () => {
    expect(autoEnqueue).toMatch(/TRUSTED_AUTHOR_LOGINS:\s*ttraenkler,/);
  });

  it("the gate honours the env var end to end", () => {
    // Plumbing check, not a restatement of #2550: the allowlist is read from
    // `process.env` at module load, so it has to be exercised in a fresh
    // process to prove the workflow's env actually reaches the decision.
    const probe = [
      "const { isTrustedAuthor } = await import('./scripts/enqueue-green-prs.mjs');",
      "process.stdout.write(JSON.stringify(isTrustedAuthor(",
      "  { assoc: 'NONE', authorLogin: 'some-app[bot]', headRepoOwner: 'loopdive' })));",
    ].join("");
    const withAllowlist = execFileSync("node", ["--input-type=module", "-e", probe], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, TRUSTED_AUTHOR_LOGINS: "ttraenkler,some-app[bot]" },
    });
    expect(JSON.parse(withAllowlist).trusted).toBe(true);

    const withoutAllowlist = execFileSync("node", ["--input-type=module", "-e", probe], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, TRUSTED_AUTHOR_LOGINS: "ttraenkler" },
    });
    expect(JSON.parse(withoutAllowlist).trusted).toBe(false);
  });
});
