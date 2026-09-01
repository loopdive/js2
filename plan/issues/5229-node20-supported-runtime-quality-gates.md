---
id: 5229
title: "Published Node 20 support floor has no package-level compatibility proof"
status: ready
sprint: current
created: 2026-08-31
updated: 2026-08-31
priority: medium
horizon: m
feasibility: medium
reasoning_effort: max
task_type: infrastructure
area: runtime, ci, tooling
language_feature: n/a
goal: dogfood
related: [1449, 3490, 3552, 3613, 3746]
requested_by: ttraenkler/codex-sol-ultra
---

# #5229 — prove the published package at its declared Node 20 floor

## Problem

The published package declares `engines.node: ">=20"` and ships `dist/`, its
CLI entry points, examples, and documentation. Required CI exercises Node 25,
but no required job packs the publication, installs it under Node 20, and runs
a bounded public API/CLI compatibility smoke. The oldest accepted package
runtime is therefore metadata without an executable regression proof.

This contract is intentionally narrower than repository development and
authoritative conformance work:

- `docs/methodology.md` requires Node 22+ for contributors;
- `docs/getting-started.md` recommends Node 22+ and documents that older hosts
  may need `--experimental-wasm-gc`; and
- #3490 and #3746 explicitly keep published-package support separate from the
  Node 25 Test262/FYI environment.

Fresh observations on audited commit
`dfd3ae92da8186d1b77c9781cb8bf40c4ef62d0f` show why a package-level smoke must
be selected deliberately, but they do **not** prove the published package is
broken:

- repository-only `scripts/check-test-vacuity-shapes.ts` imports
  `node:fs.globSync`, which is absent on official Node 20.19.5; and
- the repository's 20-file guard manifest, run without the documented Wasm
  feature flags, reports **101 failed, 149 passed, 4 skipped**, while Node
  24.19.0 reports **250 passed, 4 skipped**.

Neither repository script is included in the published `files` set, and the
unflagged guard run is outside the documented older-host command. They are
tooling-boundary evidence, not a finding against `engines.node`.

## Impact

`npm` accepts installation on Node 20, but a change that breaks the packed
entry points only at that floor cannot block a PR. Conversely, repository-only
tooling failures can be mistaken for package incompatibility when the two
contracts are not tested and named separately.

## Direction

Build or pack the exact publishable artifact, install it in an isolated Node 20
consumer fixture, and smoke the documented public surfaces: module import,
one bounded compile, the relevant instantiate/runtime path with documented
flags, and CLI startup/one minimal compilation. Keep contributor checks and
the Node 25 authoritative conformance lane separate.

If that bounded package contract cannot be supported, raise `engines.node` and
align consumer-facing documentation. Repository-only checks may independently
raise their contributor runtime or replace newer APIs, but that is not a
precondition for proving the package.

## Acceptance criteria

- [ ] Required CI builds or packs the same files that publication exposes and
      installs them into an isolated consumer fixture.
- [ ] The lowest `engines.node` major imports the public package and runs a
      minimal documented API compile/instantiate path.
- [ ] The published CLI entry points start, and the primary CLI completes one
      bounded compilation under that Node major.
- [ ] Any Wasm feature flags needed by that consumer path are applied through a
      documented command and covered by a negative control.
- [ ] Contributor-tooling and authoritative Test262 runtime requirements stay
      separately named and do not silently redefine package support.
- [ ] If the smoke cannot pass, `engines.node` and consumer-facing docs are
      raised together.
