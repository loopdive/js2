---
id: 2196
title: "Release version-bump hygiene: bump package.json on version tags + tag↔version CI guard"
status: done
created: 2026-06-18
updated: 2026-06-18
completed: 2026-06-18
priority: medium
feasibility: easy
reasoning_effort: low
sprint: Backlog
---

# #2196 -- Release version-bump hygiene: bump package.json on version tags + tag↔version CI guard

## Problem

Releases here are cut as a bare lightweight `git tag vX.Y.Z` that **never bumps
`package.json`**. `.github/workflows/publish-npm.yml` triggers on a `v*` tag
push and publishes **whatever `package.json` `version` is at that commit** — so
the `version` field has been stuck at `0.52.0` for thousands of commits, and
anyone building from the clone (the npm package `@loopdive/js2`, currently never
successfully published / 404) reads a stale `0.52.0`. An external tester hit
this on loopdive/js2#389.

There are two packages that must move in lockstep:

- `@loopdive/js2` — repo-root `package.json`.
- `js2wasm` — the unscoped proxy at `packages/js2wasm/package.json`.

## Fix (tooling only — no version bump, no tag in this change)

1. **CI guard** — a `verify-version` job in `publish-npm.yml` that runs on the
   `v*` tag-push event, strips the leading `v` from the tag, reads both
   `package.json` versions, and **fails the publish if either differs**. The
   `publish-npm` job `needs: verify-version`; `publish-jsr` is covered
   transitively. The job is skipped cleanly on the `workflow_dispatch` dry-run
   path (no version tag), and the dispatch dry-run still works end-to-end.
2. **Release script** — `scripts/release.mjs` (`node scripts/release.mjs
   <x.y.z | patch | minor | major>`, also `pnpm run release`). Resolves a single
   concrete target version and applies the SAME string to both packages via
   `pnpm version --no-git-tag-version`, asserts they match, and prints next
   steps. It does not commit/tag/push (branch-protection-safe).
3. **Doc** — `docs/releasing.md` covering the root cause, the new flow
   (bump → review → `release:` PR → merge → tag the merge commit → publish), the
   `verify-version` guard, and the lockstep root+proxy bump. Pointer added from
   `docs/ci-policy.md` (§10).

## Acceptance

- `verify-version` fails the publish when the tag version does not match BOTH
  `package.json` versions (catches the drift bug and a forgotten proxy bump).
- `scripts/release.mjs` bumps root + proxy to the same explicit version in
  lockstep and errors if they diverge.
- `docs/releasing.md` exists and documents the flow.
- This change is tooling-only: both `package.json` files remain `0.52.0` in the
  final diff (the script was tested with `0.53.0`, then reverted). The NEXT
  release will set the version correctly through the new flow.

Refs loopdive/js2#389.
