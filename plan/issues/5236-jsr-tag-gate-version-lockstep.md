---
id: 5236
title: "JSR tag gate omits jsr.json version and can authorize a stale publish"
status: ready
sprint: current
created: 2026-08-31
updated: 2026-08-31
priority: high
horizon: s
feasibility: easy
reasoning_effort: max
task_type: infrastructure
area: ci, release
language_feature: n/a
goal: release-pipeline
related: [3453, 3454, 3455]
requested_by: ttraenkler/codex-sol-ultra
---

# #5236 — verify the JSR manifest before tag-triggered publication

## Problem

PR #3384 completed #3454's contract: `scripts/release.mjs` now bumps and stages
`jsr.json` with the two package manifests. The independent tag-publish gate has
a narrower proof. In `.github/workflows/publish-npm.yml:39-60`,
`verify-version` compares the tag with:

1. root `package.json` version;
2. proxy `package.json` version; and
3. the proxy dependency on `@loopdive/js2`.

It never reads `jsr.json.version`, although the JSR job at lines 154-190 is
authorized by the shared gate and `deno publish` derives its version from that
file. Current committed values match at 0.70.0. A read-only simulation with the
first three values and tag at 0.70.0 but `jsr.json.version` at 0.69.0 passed the
workflow's exact comparisons.

The release script's post-write assertion at `scripts/release.mjs:404-414`
likewise checks the two package versions plus the dependency but not the JSR
manifest. The normal scripted release path is correct; this follow-up owns the
missing independent proof before publication.

## Impact

A manual or partial release commit can carry a new tag while leaving only
`jsr.json` stale. Both npm packages remain eligible to publish, and the JSR job
can run against the old version. Because an already-published JSR version can
exit successfully, the workflow can finish without publishing the tagged JSR
release—the same external symptom that originally exposed #3454, through a
different control path.

## Direction

Include `jsr.json.version` in the release invariant and verify it before the
JSR job. Preserve independent-registry operation deliberately: if a JSR-only
mismatch should not block npm, use a JSR-specific prerequisite rather than
weakening either registry's check.

## Acceptance criteria

- [ ] Tag verification compares `jsr.json.version` with the tag before JSR
      publication.
- [ ] Root/proxy/dependency matching while only JSR differs is a failing
      regression fixture.
- [ ] The release script's post-write assertion proves all four version values.
- [ ] A normal four-value lockstep fixture remains green.
- [ ] Registry-specific gating behavior is explicit and tested.
