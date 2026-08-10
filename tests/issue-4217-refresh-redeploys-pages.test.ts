// (#4217) The npm-compat refresh must leave the deployed site serving the
// artifact it just published.
//
// ORIGINAL BUG: the artifact commit carried `[skip ci]`, which suppresses EVERY
// workflow for that push — including `deploy-pages.yml`, whose only relevant
// trigger is `push: branches: [main]`. So the page kept serving the previous
// JSON until some later unrelated merge redeployed it (observed 2026-08-08:
// artifact published 05:56Z, last deploy 05:34Z, page stale until a manual
// dispatch at 06:22Z). #4217 patched around it with an explicit
// `gh workflow run deploy-pages.yml` after a successful push.
//
// WHY THE PIN CHANGED: promotion now goes through a PR and the merge queue, so
// the artifact commit CANNOT carry `[skip ci]` (the PR needs its checks to run
// to become mergeable) and it lands as an ordinary, CI-visible push to main.
// `deploy-pages` fires on that push by itself. The explicit dispatch is not
// just redundant now, it would be WRONG: at the moment this workflow finishes,
// the artifact is on a PR branch and not yet on main, so a dispatch would
// rebuild the STALE page and hand back #3958/#3977.
//
// So the invariant to pin is no longer "there is a dispatch step". It is the
// property that actually keeps the page fresh: the landing commit is visible to
// `deploy-pages`'s push trigger.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/npm-compat-refresh.yml", import.meta.url), "utf-8");
const deployPages = readFileSync(new URL("../.github/workflows/deploy-pages.yml", import.meta.url), "utf-8");

// Executable lines only: the workflow's comments deliberately name `[skip ci]`
// and the removed dispatch so the next reader learns why they are gone.
const code = workflow
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

describe("#4217 — the site serves the artifact the refresh publishes", () => {
  it("the artifact commit is not marked [skip ci]", () => {
    // This single marker is the whole original bug. Re-adding it would silence
    // deploy-pages again AND make the promotion PR permanently unmergeable.
    expect(code).not.toContain("[skip ci]");
  });

  it("deploy-pages still redeploys on every push to main", () => {
    // The mechanism the refresh now relies on. If someone adds a `paths:`
    // filter here, the artifact landing stops redeploying the site and the
    // staleness returns silently — hence the pin in this file rather than
    // deploy-pages' own.
    const on = deployPages.slice(deployPages.indexOf("on:"), deployPages.indexOf("permissions:"));
    expect(on).toMatch(/push:\s*\n\s*branches:\s*\n\s*-\s*main/);
    expect(on.slice(on.indexOf("push:"), on.indexOf("workflow_run:"))).not.toContain("paths");
  });

  it("does not dispatch deploy-pages from the refresh run itself", () => {
    // At that moment the artifact is on the PR branch, not on main; deploying
    // would publish the pre-refresh tree.
    expect(code).not.toContain("gh workflow run deploy-pages.yml");
    // and the permission that existed only for that dispatch is gone
    expect(code).not.toMatch(/actions:\s*write/);
  });
});
