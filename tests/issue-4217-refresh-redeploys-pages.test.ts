// (#4217) npm-compat refresh must redeploy Pages after a real artifact
// publish — the `[skip ci]` artifact commit cannot trigger its own rebuild,
// so the workflow dispatches deploy-pages.yml explicitly.
//
// The fix is workflow YAML, so the permanent repro is a shape pin: if a
// refactor drops the dispatch step, its publish guard, or the actions:write
// permission that lets GITHUB_TOKEN create the workflow_dispatch run, the
// page silently reverts to serving stale JSON until the next unrelated merge
// (observed 2026-08-08: artifact 05:56Z, last deploy 05:34Z).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/npm-compat-refresh.yml", import.meta.url), "utf-8");

describe("#4217 — npm-compat refresh redeploys Pages", () => {
  it("grants the job actions:write so GITHUB_TOKEN may dispatch deploy-pages", () => {
    expect(workflow).toMatch(/actions:\s*write/);
  });

  it("marks the promote step and emits published=1 only on a real push", () => {
    expect(workflow).toMatch(/id:\s*promote/);
    // The output is written on the successful-push path (next to the publish
    // log line), not unconditionally at step level.
    expect(workflow).toMatch(/published=1.*GITHUB_OUTPUT|"published=1" >> "\$GITHUB_OUTPUT"/);
  });

  it("dispatches deploy-pages.yml guarded on publish AND non-deferred refresh", () => {
    const dispatchStep = workflow.split(/\n {6}- name: /).find((s) => s.startsWith("Redeploy Pages"));
    expect(dispatchStep, "the redeploy step exists").toBeDefined();
    expect(dispatchStep).toMatch(/steps\.promote\.outputs\.published == '1'/);
    expect(dispatchStep).toMatch(/steps\.queue_gate\.outputs\.decision != 'defer'/);
    expect(dispatchStep).toMatch(/gh workflow run deploy-pages\.yml/);
    // Best-effort by design: a failed dispatch warns, never fails the job —
    // the artifact is already safely on main.
    expect(dispatchStep).toMatch(/::warning/);
  });
});
