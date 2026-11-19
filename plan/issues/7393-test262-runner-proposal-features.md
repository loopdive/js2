---
id: 7393
title: "test262 runner: most of test262's proposal features are scored as standard"
status: backlog
sprint: Backlog
created: 2026-11-19
updated: 2026-11-19
priority: medium
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: test262
goal: ir-full-coverage
related: [7350, 5173]
---

# #7393 — test262 runner: most of test262's proposal features are scored as standard

## Problem

`classifyTestScope` (`tests/test262-runner.ts`) marks a test as a proposal only when its `features` name an entry
of `PROPOSAL_FEATURES`, which holds two features: `import-defer` and `source-phase-imports`. test262's own
`features.txt` lists 17 under "Proposed language features" (stage 3 or earlier, "consumers may more easily omit
them"). Every test tagged with one of the other 15, outside `test/staging/`, is scored as `standard`: it counts
in the conformance denominator and in the per-edition ratchet.

Found by #7350 B2a (PR #7315): its scope test ties the global table to the classifier, and `ShadowRealm`, a
stage 2.7 proposal in no edition, came out as a standard built-in.

## Measured

test262 submodule `b363f29d3c`, files outside `test/staging/` whose frontmatter names the feature (2026-11-19):

| feature | files | `generate-editions.ts` edition |
| --- | ---: | --- |
| `Intl.Era-monthcode` | 1,566 | — |
| `Intl.NumberFormat-v3` | 99 | — |
| `await-dictionary` | 89 | 2027 |
| `immutable-arraybuffer` | 66 | 2027 |
| `ShadowRealm` | 64 | 2023 |
| `Intl.Locale-info` | 60 | — |
| `error-stack-accessor` | 35 | — |
| `legacy-regexp` | 26 | 2027 |
| `decorators` | 24 | — |
| `Iterator.prototype.join` | 18 | — |
| `import-text` | 6 | — |
| `import-bytes` | 5 | — |
| `nonextensible-applies-to-private` | 3 | — |
| `export-defer`, `source-phase-imports-module-source` | 0 not already caught | — |

(`source-phase-imports-module-source` files also carry `source-phase-imports`, so the existing entry catches
them.) Counts are files tagged, not files that would change verdict class; a file can carry several features.

## Fix

Derive `PROPOSAL_FEATURES` from test262's `features.txt` "Proposed language features" section (one source,
read at runner start) instead of a hand list, and make `generate-editions.ts`'s feature map agree (it puts
`ShadowRealm` in 2023 and three proposals in the 2027 draft).

**Needs the project lead's OK before it lands:** it moves the conformance totals (the published pass / total and
the badge), the per-edition ratchet floors (`scripts/test262-edition-ratchet-baseline.json`, whose 2027 draft and
2023 rows contain these files), and the edition timeline. Plan the baseline refresh in the same change.

## Acceptance

- `classifyTestScope` scores a test tagged with any proposed feature of `features.txt` as `proposal`; a test
  tagged only with standard features is unchanged.
- The edition map assigns no proposal to a ratified edition.
- The published totals and ratchet floors are refreshed in the same change, with the before / after numbers in
  the PR.
