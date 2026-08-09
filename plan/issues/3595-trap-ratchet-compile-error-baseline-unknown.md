---
id: 3595
title: "ci: trap ratchet must treat a compile_error baseline as baseline-unknown (it never instantiated, so it never had the chance to trap)"
status: done
completed: 2026-07-25
sprint: 77
created: 2026-07-25
updated: 2026-07-30
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ci
language_feature: n/a
goal: correctness
related: [3189, 3563, 3593]
---

# #3595 — trap ratchet: `compile_error` baseline is baseline-unknown

## Problem

The #3189 uncatchable-trap ratchet (`scripts/diff-test262.ts`,
`evaluateTrapCategoryGrowth`) already excludes three "the baseline cannot
testify" cases from trap-category growth:

1. the baseline row is **absent** (missing shard/artifact),
2. the baseline `status` is **`compile_timeout`**,
3. the baseline and candidate have an identical **`wasm_sha`**.

It did **not** exclude `compile_error` — and that is the same class. The
rationale is already written in the file for `compile_timeout`:

> A compile timeout never observed the baseline's runtime behavior. A
> subsequent trap is therefore unknown, not evidence that this change
> introduced one.

An invalid-Wasm `compile_error` module **never instantiated**, so
`__module_init` never ran and never had the opportunity to trap. A later trap on
that file is likewise _unknown_, not _introduced_.

**Consequence:** any PR that fixes a compile error is charged for whatever
latent trap the now-reachable code already contained — the ratchet punishes
exactly the CE-elimination work it is supposed to reward.

## Evidence (measured — the justification for this change)

PR #3563 (#3024 iterator-dispatcher arity, 8 CE-eliminations) was parked by
`auto-park` on:

```
GATE FAIL: trap category "null_deref" grew 159 → 160 (+1) — uncatchable-trap ratchet (#3189)
           Newly trapping: test/built-ins/Iterator/zip/iterables-iteration.js
```

That file's baseline status was **`compile_error`**. Its trap was then proven
pre-existing (#3593): the minimized repro was run twice, changing only
`src/codegen/index.ts` —

| `src/codegen/index.ts`      | result                                                  |
| --------------------------- | ------------------------------------------------------- |
| PR #3563's version          | `TRAP: dereferencing a null pointer in __module_init()` |
| restored from `origin/main` | `TRAP: dereferencing a null pointer in __module_init()` |

Byte-identical trap with the change absent. #3563 did not introduce the trap; it
merely made the module compile far enough to reach it. Meanwhile #3563 measured
**+11 pass**, host stable-path fine-gate net **+33**, and
`"not enough arguments on the stack"` rows **10 → 2 (8 fixed, 0 introduced)** —
so the gate was blocking a strongly net-positive PR on an unrelated latent
defect.

## Fix

`scripts/diff-test262.ts` — extend the baseline-unknown branch:

```ts
if (base?.status === "compile_timeout" || base?.status === "compile_error") {
  unknownBaselineTimeouts[row.error_category].push(file);
  continue;
}
```

Excluded files are still **reported** (via `unknownBaselineTimeouts`), just not
counted as category growth.

`ORACLE_VERSION` **10 → 11** (`tests/test262-oracle-version.ts`). This is a
verdict-logic change — which transitions count as trap growth — and shipping one
without the bump **wedges the merge queue** on the old-policy baseline (#3003).
No pass/fail/classification flips, so `promote-baseline` simply re-seeds at v11
on merge.

## Tests (both directions — `tests/issue-3189.test.ts`)

The exclusion must not blind the gate; a permissive miss here is worse than the
problem it solves. Four tests, verified load-bearing by reverting the fix and
confirming the first and fourth FAIL without it:

- `compile_error` → trap is **excluded** (no failure, count 0, file reported).
- `pass` → trap still **FAILS** the ratchet.
- `fail` → trap still **FAILS** the ratchet.
- a `compile_error`-unknown trap does **not hide** genuine observed growth in
  the same category.

## Accepted risk (deliberate, recorded)

Landing #3563 under this exclusion means the corpus gains **one genuinely
trapping test** (`Iterator/zip/iterables-iteration.js`) until #3593 is fixed.
This trade was made knowingly: the defect predates #3563, and blocking a
+33-net / 8-CE-elimination PR on an unrelated deep defect is bad economics.
Whoever picks up #3593 should expect a live trap in the corpus pointing at that
issue — it is not a new regression.

## Notes / follow-up

`test/built-ins/TypedArray/prototype/set/array-arg-offset-tointeger.js` is a
**flapping** ratchet row (`oob`): excluded on #3563's run because its baseline
row was absent, but it hard-failed the main-push promote job on the same `+1 oob`
breach. Not addressed here — it is a different exclusion path (missing-row, not
`compile_error`) and wants its own measurement.
