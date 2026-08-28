---
id: 5100
title: "ES2015 standalone Set constructor preserves intrinsic add"
created: 2026-08-28
updated: 2026-08-28
status: done
priority: medium
depends_on: []
es_edition: es2015
language_feature: Set constructor iterable initialization
task_type: bug
loc-budget-allow:
  - src/codegen/expressions/new-super.ts
files:
  - src/codegen/expressions/new-super.ts
  - tests/issue-5100-set-newtarget.test.ts
---

# #5100 — ES2015 standalone `Set` constructor / intrinsic `add`

## Scope

Close the bounded standalone residual in
`test/built-ins/Set/set-newtarget.js`.  The test constructs both an empty Set
and a Set from an array literal, then checks their prototypes.  The array form
must use the intrinsic `Set.prototype.add` operation while preserving the
existing native collection representation.

This is an independent lane.  It does not touch the active/completed ES2015
lanes for #4779, #4785, #4786, #5091, #5099, #1691, or StringIterator
metadata/stepping.

## Baseline

The authoritative standalone JSONL was fetched from
`loopdive/js2wasm-baselines` at revision
`bb9ce870dc2bb4b547dddbbe9b7c42fc56dfbe52` on 2026-08-28.  The tested source
head was canonical `upstream/main` commit
`857b343f344d566f3f382168a8538dd8dca26f2c`.

For `test/built-ins/Set/set-newtarget.js` the baseline row was generated at
`28.8.2026, 00:10:29`, reached the test, and reported:

| Lane | Result | Error signature |
| --- | --- | --- |
| host | pass | — |
| standalone | fail | `type_error:TypeError: Set.prototype.add is not yet implemented in --target standalone` |

The adjacent controls `Set/prototype/add/returns-this.js`,
`Set/prototype/has/returns-false-when-value-not-present-boolean.js`, and
`Set/set-get-add-method-failure.js` were green in the same standalone
baseline.  No full Test262 run is performed locally.

## Root cause and plan

When a builtin prototype flows through `Object.getPrototypeOf`, the standalone
prototype companion is materialized and seeded with its intrinsic members.
`prepareNativeSetAdderDispatch` previously treated the seeded intrinsic
`Set.prototype.add` entry as a user override.  The constructor then invoked the
first-class member closure, whose intentional standalone refusal produced the
residual TypeError instead of using native `__set_add`.

The repair gates the custom-adder lookup on the pre-scanned named-prototype
write bit.  A prototype value read alone therefore keeps the native fast path;
assignment and descriptor writes still enter the existing override dispatch.
The host lane and direct Set method lowering remain unchanged.

Validation covers the exact Test262 row on host and standalone, the three
nearby controls on both lanes, a focused constructor/prototype identity probe,
and the normal typecheck, lint, formatting, ratchet, oracle, and hook checks.

## Validation and handoff

Post-repair focused validation on commit `d14dade81693cbbd8b0004edf9305f652cdc40cc`
was green:

| Check | Result |
| --- | --- |
| Exact Test262 row, host | pass |
| Exact Test262 row, standalone | pass |
| Three host/standalone controls | 6/6 pass |
| Standalone + host constructor/prototype probe | 2/2 pass |
| Repeat exact row (host + standalone, twice) | 4/4 pass |
| Normal changed-root hook (`TEST262_WORKERS=2`) | 10/10 pass |
| TypeScript 5 / TypeScript 7 | pass / pass |
| Biome lint, Prettier, LOC/function budgets | pass / pass / pass with issue-local allowance |
| Oracle and coercion-site ratchets | pass / pass |

The completed fix is published from `codex/5100-set-newtarget` as non-draft
upstream PR #5106 against `loopdive/js2:main`.  This markdown file is the only
issue record; no GitHub issue was opened.  Root owns fresh PR CI and merge-queue
shepherding, and the lane may enter the queue only after the published head is
mergeable with every required check green.
