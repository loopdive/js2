---
id: 3454
title: "release.mjs: bump jsr.json version in lockstep (JSR frozen at 0.60.1)"
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
related: [3453, 3455]
origin: "2026-07-19 release-pipeline hardening (tech lead, ad-hoc). Retroactive tracking issue for merged PR #3384."
---

# #3454 — release.mjs never bumped jsr.json, freezing JSR publishes

## Problem

`scripts/release.mjs` bumped the two `package.json` files (root `@loopdive/js2`
and the `js2wasm` proxy) in lockstep, but **not** `jsr.json`, which carries its
own independent `version` field. `jsr publish` runs `deno publish`, which reads
`jsr.json`'s version — so with it frozen at `0.60.1`, every JSR publish after
0.60.1 silently no-op'd with "already published" (exit 0). JSR sat stale for
several releases without any error surfacing.

## What was done (PR #3384, merged)

In `scripts/release.mjs`: added `readFileSync`/`writeFileSync` imports; after
the proxy bump, read `jsr.json`, set `jsr.version = target`, write it back; and
added `jsr.json` to the `toStage` list so the release commit includes it. The
v0.62.0 tag was moved to the fixed HEAD and JSR then published 0.62.0.

## Acceptance criteria

- [x] `node scripts/release.mjs <x.y.z>` bumps `jsr.json` to the same version
      as both package.json files.
- [x] `jsr.json` is staged into the release commit.
- [x] JSR publishes the new version (no silent "already published").

## Notes

Part of the 2026-07-19 release-pipeline hardening batch alongside [[3453]]
(Node bump) and [[3455]] (auto-publish GitHub release). Root cause class is the
same as loopdive/js2#389 (a version-carrying manifest not kept in lockstep).
Filed retroactively per "file issues for ad-hoc tasks".
