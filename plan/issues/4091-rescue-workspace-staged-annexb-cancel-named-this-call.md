---
id: 4091
title: "RESCUE: Annex B cancel path + named-this-call, recovered from the shared /workspace checkout where it sat unbranched and unreviewable"
status: done
completed: 2026-08-02
sprint: 78
created: 2026-08-02
updated: 2026-08-18
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: annex-b
goal: core-semantics
related: [4023, 4025]
loc-budget-allow:
  - src/codegen/expressions/calls.ts
func-budget-allow:
  - src/codegen/expressions/calls.ts::compileCallExpression
---

# RESCUE: work recovered from the shared /workspace checkout

**Not authored by the rescuing session.** This landed as a preservation action,
not as a change anyone has vouched for. Read the "what is NOT verified" section
before treating any of it as sound.

## Why it exists

1,726 lines sat **staged in the shared `/workspace` checkout** — no branch, no
PR, no issue. Invisible to the merge queue, to `auto-enqueue`, and to every
dispatcher. It also **blocked `sync-workspace-main.sh`**, so `/workspace` was
189 commits behind, which in turn meant `sync-current-tasklist.mjs` could not
see a single issue filed that day.

Pinned first as `refs/rescued/workspace-staged-20260802` (`5f77eeaa`) so it
could not be lost, then restored here.

## How it was restored — and why that matters

**As a PATCH against current main, NOT a file copy.** The pin's base is 189
commits old. A whole-file copy onto a moved base silently reverts whatever
landed underneath, and the **diffstat is the only cheap signal** that it
happened. Verified: **778 insertions / 88 deletions across 8 files**,
byte-identical to the pin's `src/` + `tests/` portion. Nothing rode along.

`tsc --noEmit` is clean and the patch applied with **no conflicts** despite the
gap.

## Docs deliberately EXCLUDED

The pin also carried 8 `plan/issues/` files under ids
`3178/3973/3974/3975/3977/3980/3982/3983`. Those ids are now **different
issues** on main, and the content **already landed under 4020–4025** via
PR #3994 — verified by title match (pinned `3983-apply-drops-receiver` is
identical to main's `4025-apply-drops-receiver-no-this-binding`). Re-adding them
would be a duplicate-id collision *and* wrong content. Only `src/` + `tests/`
are in this PR.

## What is in it

`src/codegen/annexb-cancel.ts` (new, 376 lines) · `src/codegen/named-this-call.ts`
(new) · changes to `expressions/calls.ts`, `expressions/identifiers.ts`,
`js-errors.ts`, `statements/nested-declarations.ts` · `tests/issue-3980.test.ts`
and `tests/equivalence/this-receiver-apply.test.ts`.

Subject matter maps to what is now **#4023** (Annex B B.3.3 hoisting on early
error) and **#4025** (`.apply(thisArg)` drops the receiver).

## ⚠ What was NOT verified when this was opened

- **No test262 measurement.** None. Not stale, *absent*.
- **No kill-switch attribution**, no regression control, no funnel.
- Nobody had confirmed the two new modules do what their names say.

**The CI gates — especially the `merge_group` standalone floor (#2097) — are the
first real evidence about this change.** Two PRs were parked on that floor the
same day for −684 and −1500 host-free passes, both invisible to PR-level checks.
If this parks, that is the system working.

It parked. The measurement below is the answer.

---

# Measurement (2026-08-02, senior-dev)

## The park was real, and it had exactly ONE cause

`merge_group` run `30743793429` parked the PR on both regression gates:

| gate | improvements | regressions (ex-timeout) | net | tolerance | bucket signature |
| --- | ---: | ---: | ---: | --- | --- |
| standalone guard (#1897) | 107 | 143 | **−36** | −15 | `3b09e6051d855a32` |
| host stable-path fine gate | 146 | 152 | **−6** | 0 | `b7e705d343fd7b50` |

The framing this was dispatched under — *"an incomplete lift out of
`nested-declarations.ts`, split the working half from the broken half"* — is
**REFUTED**. There is no broken half to split off. Reading the actual regressed
files rather than the summary:

```
=== Regression error categories ===   (host)        (standalone)
  runtime_error: 152                   143
```

…and every one of those files carries the *same* error text:

```
Internal error compiling expression: Invalid value used as weak map key
```

**152 of 152 host and 143 of 143 standalone non-timeout regressions are one
defect.** Occurrences of that message across the whole corpus: **11 in the
baseline → 677 (host) / 679 (standalone) in the candidate**, i.e. ~666 files
newly hit, most of which were already failing for other reasons and so never
showed up as a `pass →` transition at all.

## Root cause

`compileIdentifierCore` (`src/codegen/expressions/identifiers.ts`) calls

```ts
const annexBSites = collectAnnexBCancelSites(id.getSourceFile());
```

`ts.Node#getSourceFile()` walks the `parent` chain, so it returns **`undefined`
for a synthesized identifier** — one the compiler manufactured mid-lowering with
no parent. `collectAnnexBCancelSites` then memoized on that key, and
`WeakMap.set(undefined, …)` throws `TypeError: Invalid value used as weak map
key`. `compileExpressionBody`'s speculative `try/catch` converts the throw into
`reportErrorNoNode("Internal error compiling expression: …")` — **a whole-file
compile_error**.

Synthesized identifiers are not exotic. The one that fired here is script-goal
top-level `this`, lowered in `expressions.ts` (#3365) by re-entering
`compileIdentifier` with a fresh `ts.factory.createIdentifier("globalThis")`.
Instrumented stack, unmodified branch:

```
TypeError: Invalid value used as weak map key
    at WeakMap.set (<anonymous>)
    at collectAnnexBCancelSites (src/codegen/annexb-cancel.ts:319)
    at compileIdentifierCore    (src/codegen/expressions/identifiers.ts:575)
```

…and the logged identifier is `id=globalThis pos=-1 end=-1 parent=undefined`,
four times in one file.

So the blast radius was never Annex B code. It was **every script-goal file that
mentions `this` at top level** — which is why the regressed buckets are
`language/statements/with` (27), `compound-assignment` (11),
`Object/defineProperty` (10), `Array/prototype` (10) and so on, none of them
Annex B.

## The fix — 2 lines, in the new module's own entry point

`collectAnnexBCancelSites(sf: ts.SourceFile | undefined)` returns a shared empty
array when `sf` is falsy, **without touching the WeakMap**. This is the narrowest
site that produces the whole effect: it is inside the module the PR adds, so the
blast radius of the fix is exactly the blast radius of the defect, and every
future caller is covered rather than just today's one.

Rejected alternatives: guarding at the `identifiers.ts` call site (same effect,
but leaves the module itself throwing for the next caller), and narrowing
`annexb-cancel.ts`'s reach (would have discarded ~96 real improvements to fix a
defect that has nothing to do with them).

## Attribution — by kill-switch removal, with a positive control

| lane | population | base (`upstream/main`) | branch, guard OFF | branch, guard ON |
| --- | ---: | ---: | ---: | ---: |
| host | 20-file control | **20/20 pass** | — | — |
| host | all 152 regressed files | (baseline says pass) | 0/152 pass | **152/152 pass** |
| standalone | all 143 regressed files | (baseline says pass) | 0/143 pass | **143/143 pass** |

Denominators are the *complete* regression sets from the parked run, not samples.
Baseline force-refreshed (`fetch-baseline-jsonl.mjs --force`, 48,346 entries) and
the standalone baseline pulled from `js2wasm-baselines` directly; re-diffing the
run's own merged artifacts against them reproduces CI's numbers
(197/147 host vs CI 193/146; 143 standalone compile_error vs CI's 143 — the small
deltas are main advancing between the 10:38 run and the 13:2x refetch).

**Instrument caveat, stated because it matters:** the local sweep uses
`runTest262File`, which is *not* the CI path — it does not apply the #2961
host-import refusal, so it cannot certify a standalone *conformance* result. It
is sound for what it is used for here (recovery from a compile-time throw, which
is lane-independent), and the `merge_group` re-run remains the certifying
measurement.

The 14 extra standalone `fail` regressions my refetch shows that CI's run did not
are all `Object.create` / `Object.defineProperty` / `Object.defineProperties`
descriptor tests — a cluster from in-flight descriptor work on `main`, i.e.
baseline drift, not this PR.

## Both halves of the change earn their place

The dispatch expected a split. Measurement says don't:

- **Annex B half** — 96 of the 147 improvements are
  `annexB/language/{global,function}-code/*-skip-early-err-*`, exactly the family
  `annexb-cancel.ts` targets. Real.
- **`.apply` half** — the `fail → pass` improvements include
  `language/function-code/10.4.3-1-{69,88}{-s,gs}.js`, whose body is literally
  `f.apply(o)` with a strict caller. Real.
- Nearly all the *other* "improvements" are `compile_timeout → pass`, i.e. flake
  recoveries, not value. CI counted 53 such `ct_flake` recoveries; do not read
  the raw 147 as 147 fixes.

Probed `.apply` shapes on the branch (all equivalent to Node): `f.apply(o)`,
`f.apply(o, [a, b])`, nested in an expression, as an argument, with a
side-effecting receiver expression (evaluated exactly once), and recursive.
`f.apply(o, argv)` with a **dynamic** argv is still wrong — but an A/B against
`upstream/main` shows it is **equally wrong on base**, so it is a pre-existing
gap that `tryReshapeApplyToNamedThisCall` deliberately declines to claim, not a
regression. That declining is the right call (see
`static_fast_path_claiming_a_case_it_cannot_handle`).

## Allowances

Both `loc-budget-allow` and `func-budget-allow` on `calls.ts` are **retained**:
the `.apply` hunk they cover is the one that produces the `10.4.3-1-*`
improvements, so the +8 is now paid for in measured conformance rather than in
reviewability alone. The retirement condition above is satisfied; had the split
removed that hunk, both allowances would have gone with it.

## TWO allowances, but ONE growth — say why before assuming it is a concession stack

This change-set carries **both** `loc-budget-allow` and `func-budget-allow`, and
the standing rule is that stacking allowances is a smell (a lane refused a second
one the same day on #4089, correctly, because the second gate was diagnosing a
*different* and real defect).

**That is not what is happening here.** Both gates are reporting the **same 8
lines**, from two angles:

| gate | reading |
| --- | --- |
| `check:loc-budget` | `src/codegen/expressions/calls.ts`: 8444 → 8452 **(+8)** |
| `check:func-budget` | `calls.ts::compileCallExpression`: 1765 → 1773 **(+8)** |

One growth, counted twice — a file-size view and a function-size view of the
identical hunk. Not two independent concessions. If the +8 goes, both go
together, which is why they share one retirement condition.

## The allowances on `calls.ts`, and their retirement condition

`src/codegen/expressions/calls.ts` grows **+8** (8452 > 8444). The allowance is
granted here **provisionally**, and the standing rule in this project is that an
allowance must be **paid for by measured value** — a 0-flip change was
deliberately shipped *without* one earlier the same day (#4084).

This one is paid for by a different currency: **making 1,726 lines of otherwise
invisible work reviewable**, and unblocking `/workspace`. That is real but it is
not a conformance argument.

**Therefore:** if this work is not validated by an owner who can measure it,
**close the PR and revert rather than keeping the allowance.** The allowance
must not outlive the justification. Do not re-baseline
`scripts/loc-budget-baseline.json` to absorb it.

The subsystem-module remedy was not attempted because the rescuing session did
not author this code and restructuring unmeasured work it cannot evaluate would
be worse than the +8.

## What an owner should do — done

1. ~~Establish whether the Annex B cancel path and `named-this-call` actually fix
   #4023 / #4025~~ — both do; see "Both halves earn their place".
2. ~~Run the funnel with a force-refreshed baseline and kill-switch
   attribution~~ — see "Attribution".
3. ~~Land it with numbers, or close it~~ — landing it, with the guard.

Remaining, and **not** in scope here: `f.apply(o, argv)` with a dynamic argv is
still wrong on `main`. That is #4025's uncovered tail; file/route separately
rather than widening `tryReshapeApplyToNamedThisCall` to a shape it cannot
lower correctly.

## Lesson worth keeping

A summary line said `runtime_error: 152`. The files said
`Invalid value used as weak map key` — a *compile-time* throw laundered through a
speculative catch into a per-file compile error. Reading the regressed **files**
instead of the regression **summary** turned "both fixes and breaks heavily,
split it" into a two-line guard in twenty minutes. The category field was not
lying; it just could not see through the catch.
