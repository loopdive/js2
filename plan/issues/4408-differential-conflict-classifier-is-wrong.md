---
id: 4408
title: "Differential oracle: the conflict classifier is wrong — 908 reported conflicts are 88"
status: done
sprint: 78
created: 2026-08-14
updated: 2026-08-18
completed: 2026-08-14
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bug
area: checker
goal: correctness
parent: 4218
---

## Problem

`DivergenceLedger.isWeaker` (`src/checker/oracle-backend.ts`) decides whether a
divergence is a **safe weakening** (the in-house backend declined to answer) or
a **conflict** (both backends claim a fact and the facts differ) by testing the
_whole answer string_ against four literals:

```ts
function isWeaker(answer: string): boolean {
  return answer === "unresolvable" || answer === "undefined" || answer === "mixed" || answer === "[]";
}
```

That is only correct for scalar answers. It is wrong for every other answer
shape the oracle produces, in four distinct ways:

1. **Weakening nested inside a composite.** `signatureOf` renders as
   `(p1,p2)->r#arity`. The in-house answer `(unresolvable)->unresolvable#1`
   is a total abstention, but the string is not one of the four literals, so it
   is counted as a conflict. Same for `array<any>` vs `array<number>`.
2. **Weakening expressed as a boolean polarity.** For `isBooleanProducing`,
   `false` is the conservative answer; for `isUnresolvableIdentifier`, `true`
   is. Both were counted as conflicts.
3. **Weakening on the CHECKER side.** `declarationsOf` returning `[]` from the
   checker means _the checker_ declined — the ledger has no category for that
   at all, so it lands in `conflicting` and reads as an in-house bug.
4. **`any` treated as a fact.** The checker's `any` carries no static
   information for a wasm lowerer; it is the same answer as `unresolvable`.
   The classifier scores `any` vs `unresolvable` as a disagreement.

## Impact

The headline number from the wide differential run (2,137 inputs) was
**908 conflicting facts**, with `signatureOf` at a **95.9 % conflict rate**.
That number was quoted as the gate on retiring the TS5 checker.

Re-classifying the same 908 rows structurally:

| bucket                                            | count   |
| ------------------------------------------------- | ------- |
| same meaning (`any` ≡ `unresolvable`, etc.)       | **136** |
| in-house weaker (safe abstention, mislabelled)    | **318** |
| checker weaker (in-house claims MORE — see #4410) | **366** |
| genuine both-claim-different-facts                | **88**  |

Per query:

| query                      | same | inhouse-weaker | checker-weaker | GENUINE |
| -------------------------- | ---- | -------------- | -------------- | ------- |
| `declarationsOf`           | 0    | 0              | 34             | 44      |
| `valueDeclarationOf`       | 0    | 0              | 196            | 24      |
| `typeFactOf`               | 46   | 10             | 42             | 14      |
| `variableDeclarationOf`    | 0    | 0              | 36             | 6       |
| `signatureOf`              | 90   | 284            | 0              | **0**   |
| `isUnresolvableIdentifier` | 0    | 12             | 4              | 0       |
| `staticJsTypeOf`           | 0    | 0              | 36             | 0       |
| `isBooleanProducing`       | 0    | 12             | 0              | 0       |
| `declaredNameOf`           | 0    | 0              | 18             | 0       |

`signatureOf` — the query that dominated the original number, 374 of 908, at a
reported 95.9 % "conflict rate" — has **zero** genuine conflicts. Every one of
those rows is either a total in-house abstention or the same answer spelled
differently (`any` vs `unresolvable`). The 95.9 % was an abstention rate
rendered through a broken predicate.

Reproduce: `npx tsx scripts/audit-oracle-differential.mts --corpus all`.

## Second defect: conflicts were unsampleable

`DivergenceLedger.samples` is one FIFO over _all_ divergences, capped at 200
per file. `weakened` outnumbers `conflicting` roughly 54:1, so the cap fills
with weakened entries before a single conflict is recorded. On the 2,137-input
run, 908 conflicts existed and **25** were sampled — none of them from
`signatureOf`, the query with the highest apparent conflict rate. A worklist
whose top item is invisible is not a worklist.

Fixed in the same change: a separate `conflictSamples` list with a per-query
quota (`maxConflictsPerQuery`, default 60). With it, all 908 conflicts are
recoverable from 237 files.

## Acceptance criteria

- [x] `isWeaker` is replaced by a structural classifier producing a four-way
      verdict: `same-meaning` | `inhouse-weaker` | `checker-weaker` |
      `genuine-conflict` (`src/checker/divergence-classifier.ts`).
- [x] The classifier understands composite answers (signature strings, nested
      generic fact strings), per-query polarity, list emptiness on either side,
      `any` ≡ `unresolvable`, and total abstention across differing shapes
      (with declared arity compared exactly, so an arity mismatch stays a
      conflict however blank the rest is).
- [x] `checker-weaker` is a first-class bucket, not folded into conflicts —
      "the in-house backend knows more than TypeScript" is a real and frequent
      outcome (#4410), not a bug signal.
- [x] `DivergenceLedger` keeps per-query-quota'd conflict samples, and each
      sample carries its verdict.
- [x] `scripts/audit-oracle-differential.mts` reports the four-way split.
- [x] A unit test pins each mis-classification above with a literal answer
      pair, so the predicate cannot silently regress to string equality
      (`tests/issue-4408-divergence-classifier.test.ts`).

## Notes

Everything published from the old classifier is wrong by roughly 10× and
should be restated: the corrected genuine-conflict count is **88**, and the
correct retirement gate is "genuine-conflict == 0 **and** every
`checker-weaker` row adjudicated", not "conflicting == 0".

The remaining 88 are concentrated in four binding-resolution queries and are
adjudicated in #4410 — a share of them are cases where TypeScript is the
wrong one.
