---
id: 7417
title: "`tests/issue-3518-historical-runtime-reconstruction.test.ts` fails all 631 assertions on main (stale `provider-policy.ts` pin)"
status: ready
sprint: current
created: 2026-11-19
updated: 2026-11-19
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
goal: ir-full-coverage
related: [3518, 7358, 7408, 6979, 7355]
---

# #7417 — the #3518 historical runtime reconstruction is red on main

## Problem

Found while measuring #7355. On `origin/main` ee3fcdd610 (2026-11-19), every assertion in
`tests/issue-3518-historical-runtime-reconstruction.test.ts` fails, 631 of 631 (596 distinct test names). Each
failure has the same message:

```
Error: runtime contract evolution: complete source SHA256/length mismatch: src/runtime/contracts/provider-policy.ts
```

The check lives in `tests/helpers/ir-runtime-contract-evolution.ts`, which compares each path in
`runtimeContractCurrentPaths` against the receipt `tests/helpers/ir-runtime-contract-evolution.json`.
`provider-policy.ts` is the first path in that list. The test stops at the first mismatch, so other pinned paths
could also be stale; nobody has checked.

## First breaking merge

The receipt pins the `provider-policy.ts` blob `9e1179582374…`, which is the file as of c2fb27fed2 (2026-09-27).
The file then changed twice, and both commits reached main in one merge:

| commit | date | blob |
| --- | --- | --- |
| 54c2036b92 `merge(#6979 S7-d)` | 2026-11-06 | `4f578ed0139b…` |
| 48825fd9bb `refactor(#6979): S7 chain — delete constant IR resolver hooks` | 2026-11-13 | `375eaa6004ae…` (main today) |

- **First red merge on main:** 43f1142a41, "Merge pull request #7226 from loopdive/claude/6979-s7-chain"
  (2026-11-14).
- **Its first parent** still carries the pinned blob `9e117958…`.
- This was traced from blob history on the first-parent chain. The test was not run at each commit.

## Why nothing caught it

No required CI job runs this file. It is not in the fatal `issue-tests-pinned` set: `select-changed-issue-tests.mjs
--pinned` lists 15 files on main and this is not one of them. The `issue-tests-select` job runs it only when the
file itself changes, and even then only as an advisory check (`continue-on-error: true`). #7358 found the same gap
for `tests/issue-3518-runtime-program-relocation.test.ts`.

## Rule for the fix

Do not refresh the hash blindly (the same rule as #7358). The receipt records a reviewed contract. A new pin needs a
reviewed replay step that explains the S7 changes to `provider-policy.ts`: a hash-checked inverse span, like
`tests/helpers/same-value-nan-correction.ts`. Then re-run the whole file and check whether any further path is stale.
