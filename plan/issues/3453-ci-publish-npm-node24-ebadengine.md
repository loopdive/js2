---
id: 3453
title: "CI publish: bump publish-npm.yml Node 20 → 24 (npm 12 EBADENGINE)"
status: done
sprint: current
created: 2026-07-19
updated: 2026-07-19
completed: 2026-07-19
priority: high
horizon: s
feasibility: easy
task_type: bug
area: ci, release
goal: release-pipeline
related: [3454, 3455]
origin: "2026-07-19 release-pipeline hardening (tech lead, ad-hoc). Retroactive tracking issue for merged PR #3381."
---

# #3453 — publish-npm.yml ran Node 20, incompatible with npm@latest (npm 12)

## Problem

`publish-npm.yml`'s three jobs pinned `node-version: 20`, then ran
`npm install -g npm@latest` for OIDC trusted publishing. npm 12 requires Node
`^22.22.2 || ^24.15.0 || >=26.0.0`, so the install failed with `EBADENGINE`
and the **v0.61.0 npm publish never ran** (it only surfaced when the release
was cut). Node 25 (the repo default) is excluded by npm 12's engine range, so
the fix had to pick an explicitly-supported LTS.

## What was done (PR #3381, merged)

Bumped all three `actions/setup-node` steps in `.github/workflows/publish-npm.yml`
from `node-version: 20` to `24` (the nearest supported even LTS in npm 12's
range). v0.62.0 subsequently published to npm cleanly.

## Acceptance criteria

- [x] publish-npm.yml uses a Node version inside npm@latest's engine range.
- [x] npm trusted-publishing (`npm publish --provenance`) succeeds on a real
      tag push.

## Notes

Part of the 2026-07-19 release-pipeline hardening batch alongside [[3454]]
(jsr lockstep) and [[3455]] (auto-publish GitHub release). Filed retroactively
per "file issues for ad-hoc tasks".
