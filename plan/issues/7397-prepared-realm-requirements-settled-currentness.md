---
id: 7397
title: "Prepared: realm-requirements currentness re-derived at every check (per string literal)"
status: in-progress
sprint: current
created: 2026-11-19
updated: 2026-11-19
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
depends_on: []
related: [7354, 7365, 7398]
---

# #7397 — realm requirements: one currentness check per unchangeable pack

## Problem

Found while profiling #7365. `assertNativeRealmRequirementsCurrent`
(`src/ir/program/native-realm-requirements.ts`) re-derives the whole realm
description on every call: `calculate`, whose `numberUses` scans every owner ×
occurrence.

The string-literal emit chain calls it once per emitted literal
(`emitPreparedNativeStringLiteral` → `ownerFor` → `checkCompletedOwner` →
`planNativeRealmLiterals` → `assertNativeRealmRequirementsCurrent`). Its cost
therefore grows with literals × program size.

The test program is the prelude-shaped synthetic program of #7365. Each of its
sizes doubles the previous one: q = 21 function values, 5 object literals,
15 strings, 11 `+`; h = twice q; f = four times q. On `claude/7354-o` + B′,
the f compile spends 31 % in this chain, and `numberUses` grows ×44 from q to
f, against a ×4 larger program.

## Implementation Plan

- **Module:** `src/ir/program/native-realm-requirements.ts` only.
- **Reuse:** the #7354 Perf settled-verdict mechanism
  (`src/ir/program/settled-verdict.ts`), in the exact shape
  `native-object-access-requirements.ts` already uses:
  `authentication: settledAtIssue(pack)` at issue, and
  `checkUnlessSettled(owner.authentication, pack, () => same(calculate(…), …))`
  in the check.
- **No new mechanism, no cache beside the check.** The verdict holds only
  while the pack is deeply immutable (`isImmutablePreparedIrValue`, decided at
  issue) and the shared prototypes are unchanged. Otherwise it re-checks at
  every use, as before (fail closed).
- **Contract:** neutral. A pack that can change is re-checked at every use.
  A settled pack cannot change.
- **Quality criterion:** the diff is the two lines of the existing pattern
  plus the owner field; no other module changes.

## Measured (2026-11-19)

The prelude-shaped program of #7365 (`/home/user/js2/.tmp/c7365-profile/programs-prelude.json`),
compiled through `src/test262/test262-prepared-entry.ts`. Each size is
compiled 2× in one process, and both times are given.

| base | q | h | f | sha1 q / h / f |
|---|---|---|---|---|
| `claude/7354-o` 53357b3b | 32.6 / 32.4 s | 47.4 / 45.2 s | 84.9 / 91.7 s | 247da933 / 28148a80 / e6ec6c68 |
| `claude/7354-o` + #7397 | 37.0 / 37.8 s | 46.7 / 46.6 s | 73.8 / 72.3 s | identical |
| `claude/7354-o` + B′ c0433660 | 12.4 / 10.9 s | 21.1 / 19.7 s | 55.2 / 52.7 s | identical |
| `claude/7354-o` + B′ + #7397 | 10.8 / 10.3 s | 17.7 / 16.7 s | 32.4 / 34.0 s | identical |

- Without B′, the reservation audit of #7365 dominates, and the q / h
  difference is within run-to-run noise on this box.
- With B′, f goes from 54 s to 33 s, and q→f scales ×3.2 for a 4× larger
  program; before the change it was ×4.6.

## Known limit

`planNativeSourceClosureRequirements` issues its arrays unfrozen
(`Object.freeze({ ...data, demands })` freezes one level only). A realm pack
that carries source-closure requirements therefore never settles and is
re-checked at every use, as before. Issuing the frozen `snapshot` there would
let it settle. That is a separate change in another module, not made here.

## Follow-up (next step, not in this change)

- **Freeze the source-closure planner's issued arrays.** In
  `planNativeSourceClosureRequirements`, issue `Object.freeze({ ...snapshot, demands })` from the frozen snapshot,
  so that a realm pack carrying source-closure requirements can settle too. Until then such a pack is re-checked at
  every use. File it as its own issue once a measurement shows its share.

## Acceptance criteria

1. Prelude-shaped program q/h/f: before/after times, sha1 identical.
2. `tests/issue-7397-realm-requirements-settled.test.ts`:
   - a genuine frozen pack is checked once;
   - a mutable pack is re-checked and refuses a mutation after repeated passes;
   - a shared-prototype change re-checks a settled pack;
   - a source-carrying pack is re-checked at every use;
   - a copied pack is refused.
   The first test fails without the change.
3. The realm, request-literal, realm-declaration, #7354 Perf and #7354 O test
   files: no new failures.
