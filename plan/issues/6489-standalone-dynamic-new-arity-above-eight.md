---
id: 6489
title: "standalone: `new <runtime ctor value>(a0 … a8)` with MORE than eight arguments evaluates to null and never evaluates its arguments — the construct-driver admission ceiling was the `__call_fn_method_<N>` range"
status: done
completed: 2026-09-14
sprint: current
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
goal: standalone-gap
parent: 5383
assignee: ttraenkler/s24-lane
created: 2026-09-14
---

## Problem

Under `--target standalone`, `new <constructor VALUE>(…)` answers **null**, with
none of its argument expressions evaluated, as soon as the call site has **nine
or more** arguments — but only when the callee is a constructor the compiling
module does not own. A module-local class takes the per-class tag-dispatch
fallback and is correct at any arity, which is why this never showed up in a
single-module probe.

Measured on this branch's base, across the link, provider = the unmodified
`@js-temporal/polyfill` (`.tmp/s24/link3.mjs`):

| call site | base | expected |
| --- | --- | --- |
| `new Temporal.Duration(1 × 8)` | instance | instance |
| `new Temporal.Duration(1 × 9)` | **null** | instance |
| `new Temporal.Duration(1 × 10)` | **null** | instance |
| `new Temporal.PlainDateTime(2000, 5, 2, 12, 34, 56, 987, 654, 321)` | **null** | instance |
| 10 arguments, each a marked call | **null, marks never run** | marks run in order |

The consumer's view of the failure is the polyfill's own guard, several frames
later: `ToTemporalDuration(null)` falls into its string branch and
`RequireString` throws **`TypeError: expected a string, not null`**.

## Root cause

`tryCompileNativeConstructFromValue` (`src/codegen/expressions/new-super.ts`)
declined above `MAX_NATIVE_CONSTRUCT_ARITY` (8). That constant is **not** a
property of the construct driver — it is the range over which
`closure-exports.ts` emits the `__call_fn_method_<N>` dispatcher family
(`/^__call_fn_method_([0-8])$/`), used by the driver's ordinary
module-local-closure tail. Every other arm of the driver — class, link-boundary,
proxy, runtime-marker — already packs an argument VECTOR and is arity-generic.

Declining is not a graceful fallback. For a callee the module does not own there
are no candidate classes for `emitDynamicNewFallback` to tag-dispatch on, so the
site lands on the pre-existing `ref.null.extern` no-match base — and that base
is emitted *instead of* the argument evaluation, so the arguments are dropped
too. Same signature as #6485, one ceiling further out.

## Fix

- `MAX_DYNAMIC_CONSTRUCT_ARITY = 16` (new) is the call-site admission ceiling
  and the fill/scan bound; `MAX_NATIVE_CONSTRUCT_ARITY = 8` keeps its real
  meaning, "the highest arity `__call_fn_method_<N>` exists for".
- Above 8 the driver's ordinary tail packs an argv and calls `__apply_closure`
  — the same terminal its runtime-marker arm already uses. Gated strictly on
  `arity > MAX_NATIVE_CONSTRUCT_ARITY`, so the long-standing
  `methodCallIdx === undefined` case at arities ≤ 8 (a driver reserved only for
  Proxy → admitted-JS construction) keeps its exact previous null tail and every
  module that compiled before stays byte-identical.

## Acceptance

- `new <foreign ctor value>(…)` with 9–16 arguments constructs, and evaluates
  its arguments left to right.
- A driver of arity ≤ 8 is byte-identical.
- `tests/issue-6489-dynamic-new-arity.test.ts`: single-module + linked-pair
  witnesses, plus the arity-8 no-change control.

## Measured (2026-09-14, branch `issue-5383-standalone-temporal-s24b`)

Base produced on this tree by file-copy revert of the two changed files
(`.tmp/s24base/`), both labels under the same load, fresh provider cache per
label (`cacheHit=false` on prewarm, 3,307,526 B both labels), sequential,
`--target standalone`, provider linked. Every row that was `compile_error` on
EITHER tree was re-run solo at a 60 s budget on BOTH trees, so the table has no
`compile_error` cell.

| family (120 rows each) | base | new | Δ | pass→fail | fail→pass |
| --- | --- | --- | --- | --- | --- |
| `built-ins/Temporal/PlainDate/**` | 97 | 101 | +4 | 0 | 4 |
| `built-ins/Temporal/Duration/**` | 77 | 97 | +20 | 0 | 20 |
| `built-ins/Temporal/ZonedDateTime/prototype/**` | 97 | 102 | +5 | 0 | 5 |
| **total** | **271** | **300** | **+29** | **0** | **29** |

The base total of 271 reproduces S23's measured 271 exactly.

The `TypeError: expected a string, not null` bucket this slice was dispatched
on goes **9 → 0**. Seven rows pass; two
(`ZonedDateTime/prototype/add/math-order-of-operations-add-{constrain,none}`)
now construct and fail later and differently, at
`TypeError: Cannot read properties of undefined (reading 'equals')`.

## Controls

- **Must-not-move**, per file, base vs branch: **331 rows, 0 flips** —
  `Object/keys` + `language/expressions/object` + `Reflect/{get,has}` (101);
  `Object/{entries,values,getOwnPropertyNames}` + `statements/for-in` (121);
  `language/expressions/new/**` + `Function/prototype/apply/**` +
  `Reflect/construct/**` (109, the arity-sensitive group).
- **Corpus byte A/B**: 42 modules × {gc, standalone} = 84 artifacts, **0 move**.
  A null control — no module in that corpus constructs above arity 8.
- **Byte control** (`.tmp/s24/bytes6489.mts`), which is the evidence the corpus
  cannot give: the provider is byte-identical (`5989617a8d3a63a1`, 155,718 B),
  the consumer with an above-8 dynamic `new` moves (132,000 → 134,060 B), and
  the consumers with an arity-8 `new` and with no dynamic `new` are
  byte-identical. The real `@js-temporal/polyfill` provider artifact is
  3,307,526 B under both labels.
- **Equivalence gate**: 22 failing / 1,720 passing — baseline.

## Witness test

`tests/issue-6489-dynamic-new-arity.test.ts`. Measured on both trees by
file-copy revert: on base the linked `it` FAILS and both single-module `it`s
pass; on the branch all three pass. The single-module cases are labelled
CONTROLS, not witnesses, because a module owns its own classes and so the
tag-dispatch fallback always had a candidate — which is why no single-module
probe ever found this.

Four residuals are pinned in that file: the bound-identifier spelling
(`const C = NS.wide; new C(…)`) at arity 10 AND at arity 8, the fact that it
evaluates its arguments, and a foreign `new (<call>)(…)`. All are null on both
trees and none is this defect.

## Claim

`node scripts/claim-issue.mjs 6489 --check` →
`#6489 is UNASSIGNED (read origin/issue-assignments)`. The lane that opened this
issue was killed by a container restart before it wrote a claim, and this
session cannot write one — all pushes return 403. `check:issue-ids:against-main`
passes, so the id is free on `main`.
