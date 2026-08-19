---
id: 4466
title: "#4507 landed 7 test262 regressions on main — three independent codegen defects the queue let through"
status: done
sprint: 78
created: 2026-08-15
updated: 2026-08-18
completed: 2026-08-15
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: spec-completeness
# The growth in both files is comment, not logic: each fix records WHY the
# constraint it restores is load-bearing, so the next change does not remove it
# again the way #4507 did. Net logic is roughly flat — the gate in
# closed-method-dispatch.ts trades an inline `.some(...)` for a named predicate,
# and literals.ts only re-adds one condition.
loc-budget-allow:
  - src/codegen/closed-method-dispatch.ts
  - src/codegen/literals.ts
# Same reason, function scope: the whole +11 here is the comment explaining why
# the `native-first` gate must stay. Splitting the function to make room for a
# comment would be the wrong response to a regression fix.
func-budget-allow:
  - src/codegen/literals.ts::compileObjectLiteralWithAccessors
---

# #4466 — #4507 landed 7 test262 regressions on main

## Problem

PR #4507 ("fix(marked): bound upstream compilation and preserve class object
shapes", merged as `6756ed8c2`) turned 7 test262 tests from `pass` to `fail` on
`main`. They are real and deterministic, not flake — reproduced three times on
`976e0f886` through the same execution function CI's js-host shard uses, with
identical error text every run.

| test262 file | error |
| --- | --- |
| `language/expressions/object/dstr/meth-dflt-obj-ptrn-empty.js` | `Cannot destructure 'null' or 'undefined' [in __anon_5_method()]` |
| `language/expressions/object/dstr/gen-meth-dflt-obj-ptrn-empty.js` | same |
| `language/expressions/object/dstr/async-gen-meth-dflt-obj-ptrn-empty.js` | same |
| `language/expressions/array/spread-obj-manipulate-outter-obj-in-getter.js` | `Expected SameValue(«true», «false»)` |
| `language/expressions/new/spread-obj-manipulate-outter-obj-in-getter.js` | same |
| `language/expressions/super/call-spread-obj-manipulate-outter-obj-in-getter.js` | same |
| `language/statements/class/elements/super-access-inside-a-private-method.js` | `dereferencing a null pointer [in __obj_meth_tramp_C___priv_m_cached()]` |

### How it reached main despite the gate catching it

The queue did its job and was overruled by its own baseline moving:

- #4507's `merge_group` run reported exactly these 7 as regressions and failed.
- #4567's `merge_group` run (a completely unrelated PR, whose group sat on top
  of #4507) reported the **identical** 7 and failed —
  [run 31892848578](https://github.com/loopdive/js2wasm/actions/runs/31892848578).
- The next group, #4566's, was built speculatively **on top of #4567** —
  therefore containing both PRs' code — and reported **0 regressions** against
  the *same* baseline sha (`e07c1a6`). That group passed and merged, and
  speculative batching carried #4507 and #4567 in with it.

So an identical failure signature on two unrelated PRs read as the drift
signature the gate itself documents ("overlapping clusters across unrelated PRs
are drift"), while the 0-regression neighbour looked like exoneration. Both
readings were wrong: the cluster was one PR's real defect, seen by every group
that contained it.

**Baseline consequence, worth knowing:** the promoted baseline now banks three
of the seven (`*-dflt-obj-ptrn-empty`) as `fail`. A gate cannot flag what it
already records as failing, so those three were unprotected until this fix
lands and the next promote restores them to `pass`.

## Attribution

Adjacent-commit A/B (`c3ff8a1fa` = `6756ed8c2^1`), then per-file revert from
`6756ed8c2`, then per-hunk. All 7 pass at `c3ff8a1fa`; all 7 fail at
`6756ed8c2`. Three independent defects, one per failure family:

| file | failures | mechanism |
| --- | --- | --- |
| `src/codegen/closed-method-dispatch.ts` | the 3 `*-dflt-obj-ptrn-empty` | relaxed arity gate admits under-application the arm cannot express |
| `src/codegen/literals.ts` | the 3 spread-getter | dropped `native-first` gate puts the host lane on eager materialization |
| `src/codegen/closures/method-trampolines.ts` | the private-method one | receiver re-coerced on the finalize REBUILD path |

### (1) The under-application gate admits more than the arm can express

#4507 relaxed `collectMethodEntries`' arity check from "exactly `1 + exactArity`
params" to "under-application is fine when every omitted formal is optional",
and taught `buildEntryArm` to synthesize a value for each omitted formal. Those
are two different questions, and merging them is the bug.

`buildEntryArm` can only faithfully stand in for an omitted formal whose default
is a **compile-time constant** (it materializes the constant) or whose type is
**f64** (it pushes the `0x7ff00000deadc0de` NaN sentinel the callee's prologue
recognizes). For every other lane it pushes a typed zero/null — which the callee
cannot distinguish from an explicitly passed argument. So `method({} = obj)`
called with no arguments never runs `= obj` and destructures a null.

Setting `$__argc` in the arm (mirroring `maybeSetArgcForKnownCall`) was tried
and does **not** fix it — the callee still destructures null — and pushing the
argc restore *after* the call breaks Wasm validation outright
(`f64.convert_i32_s expected type i32, found call of type externref`), because a
later fixup pass depends on the call being the last instruction before result
coercion. **Fix:** admit only what the arm can express; everything else falls
back to the host path exactly as before #4507.

Cost: #4507's cited marked case (`inline(text)` with `tokens = []`, an
expression default on a ref-typed formal) goes back to the host fallback. That
is the correct trade — a conformance gain bought with a silently wrong value is
negative value — but it is a real partial revert of #4507's intent, and a
follow-up that gives ref-typed expression defaults a genuine absence signal
would recover it.

### (2) The `native-first` gate on spread materialization is load-bearing

#4507 removed `ctx.targetProfile.semanticProviders === "native-first"` from the
closed-struct spread-source materialization, so the **JS-host** lane also
materializes the struct into an open `$Object` before `__object_assign`. The
host lane already reads closed structs through host reflection and needs no
materialization — and materializing changes observable behaviour: the eager
field walk snapshots the source *before* `__object_assign` runs, so a getter
that mutates the other spread source mid-spread no longer sees spec
CopyDataProperties ordering. **Fix:** restore the gate.

### (3) Don't re-coerce the receiver on the finalize rebuild

#4507 added `coerceTrampolineThisSlot` at three sites. The two emit-time sites
are fine. The third, in `finalizeMethodTrampolines`, runs on the rebuild path
and aliases `tFctx.body = newBody` so the coercion can append there — which is
independently against the rule in `CLAUDE.md` ("`body: []` in FunctionContext,
NOT `body: func.body` — shared references break the savedBody/swap pattern").
Removing that hunk fixes the private-method trampoline; the other two sites stay.

## Fix

- `closed-method-dispatch.ts` — `canSynthesizeOmitted` gate: constant default,
  or `?` with no initializer, or an f64 expression default. Nothing else.
- `literals.ts` — restore the `native-first` gate, with a comment recording why
  removing it is not a safe trade.
- `closures/method-trampolines.ts` — drop the finalize-path re-coercion and its
  `tFctx.body` aliasing.

## Verification

All 7 test262 files, js-host lane, run through `runTest262Chunk` (the same
function `tests/test262-chunk*.test.ts` call) scoped by `TEST262_PATH_FILTER`:

| state | result |
| --- | --- |
| `c3ff8a1fa` (before #4507) | 7 pass |
| `main` `9e17d34f3` | **0 pass, 7 fail** |
| main + this fix | **7 pass** |

`tests/multi-file.test.ts` (touched by #4507) passes. TS5 typecheck clean.

`tests/issue-4466-4507-conformance-regression.test.ts` pins root cause (3) and
is verified non-vacuous — it fails against the unfixed compiler. Root causes (1)
and (2) have **no** unit test on purpose: every reduced source tried for them
either failed for an unrelated reason or passed pre-fix, i.e. never reached the
path that broke. Their coverage is the six test262 files, named in that test
file's header. See also `plan/issues/1363-spec-gap-class-dstr-runtime-cannot-destructure-null.md`,
which fixed this same "Cannot destructure" family in Sprint 51.

## Follow-ups (not in this PR)

- Give ref-typed expression defaults a real absence signal so the under-applied
  closed-method arm can serve marked's `inline(text)` case again.
- The queue hole this exposed: a group that contains a failing predecessor can
  report 0 regressions because the baseline it diffs against has moved, and
  speculative batching then merges the predecessor. Worth a separate issue
  against the merge-group regression gate.
