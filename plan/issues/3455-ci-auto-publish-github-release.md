---
id: 3455
title: "CI publish: auto-publish the GitHub release on tag push (was stuck draft)"
status: in-review
sprint: current
created: 2026-07-19
updated: 2026-07-19
priority: high
horizon: s
feasibility: easy
task_type: bug
area: ci, release
goal: release-pipeline
related: [3453, 3454]
origin: "2026-07-19 release-pipeline hardening (tech lead, ad-hoc). Tracking issue for PR #3386."
---

# #3455 — GitHub release object left in DRAFT; no workflow publishes it

## Problem

The GitHub **Release** object was created by hand and left in **DRAFT** state.
v0.62.0 published to npm (`@loopdive/js2` + `js2wasm` proxy) and JSR, but the
GitHub release sat as an unpublished draft (with the `untagged-…` preview URL)
until a manual `gh release edit --draft=false --latest` on 2026-07-19. No
workflow ever marked it live — `publish-npm.yml` touches npm/JSR only.

## What was done (PR #3386)

Added a `publish-github-release` job to `.github/workflows/publish-npm.yml`. On
a real tag push, once `verify-version` passes, it undrafts + marks-latest the
release for the tag (`gh release edit --draft=false --latest`), or creates it
published with `--generate-notes` if absent. Gated on `verify-version` success
only (via `always() && needs.verify-version.result == 'success'`) so a transient
registry hiccup in an individual publish job can't block the release. Job-level
`permissions: contents: write` grants the `gh release` permission (workflow
default is `contents: read`). Idempotent (exists-check picks edit-vs-create).

## Acceptance criteria

- [x] A `publish-github-release` job exists in publish-npm.yml.
- [ ] On the next tag push, the GitHub release goes live (non-draft, latest)
      automatically — verify on the v0.63.0 cut.

## Notes

Part of the 2026-07-19 release-pipeline hardening batch alongside [[3453]]
(Node bump) and [[3454]] (jsr lockstep). Set to `done` when PR #3386 merges;
the second acceptance box is confirmed on the next real release. Filed per
"file issues for ad-hoc tasks".
