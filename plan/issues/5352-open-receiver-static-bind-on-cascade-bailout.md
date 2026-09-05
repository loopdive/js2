---
id: 5352
title: "Open-receiver `this.m()` statically binds to candidates[0] when the tag-cascade emitter bails — routes every non-Hebrew Temporal calendar into HebrewHelper (120 of 123 rows)"
status: ready
sprint: current
priority: high
horizon: m
goal: core-semantics
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-09-05
---

# #5352 — open-receiver dispatch binds statically to `candidates[0]` on cascade bail-out

## Problem

For an OPEN-receiver call — `this.m(...)` where the receiver's class declares no
`m`, so every implementation lives below it — `call-receiver-method.ts` collects
the descendant candidates (#5249 widened this to the full descendant set) and,
when there is more than one, asks `emitVirtualMethodDispatchByTag`
(`src/codegen/expressions/virtual-dispatch.ts`) for a `__tag` cascade. That
emitter has NINE transactional bail-outs (`return undefined`). When any fires,
the caller falls through with `funcIdx = candidates[0].funcIdx` and emits a
**direct static call to the first declarer** — for every receiver, whatever its
runtime type.

Measured (PR #5577, all 123 rows of the #5249 family, provider linked): **120 of
123 rows** share ONE chain —
`HelperBase_calendarToIsoDate → HelperBase_regulateMonthDayNaive →
HebrewHelper_maximumMonthLength → HebrewHelper_minMaxMonthLength` — for
Japanese, Gregory, Roc, Coptic, Ethiopic, Buddhist and Islamic calendar rows
alike. `HebrewHelper` is `candidates[0]` (first declarer in `classParentMap`
order); its body then reads `this.months` on a non-Hebrew receiver and traps
`illegal cast`. The `illegal cast` is the symptom; the static bind is the
defect. This supersedes the "HebrewHelper illegal cast" row of #5251.

## Implementation Plan (Fable, 2026-09-05)

**Step 1 — identify WHICH bail-out fires for `this.maximumMonthLength(e)`.**
Instrument (a `.tmp/` probe, or a temporary `JS2WASM_DEBUG_VDISPATCH` env log)
the nine `return undefined` sites in `emitVirtualMethodDispatchByTag`, build
the provider, and record the site. Candidates, most to least likely:
- L152 `unified === undefined` — result-type unification across candidates
  fails. The polyfill's `maximumMonthLength` bodies return `30` (numeric),
  `12===t?29:t<=6?31:30` (numeric), `this.getMonthInfo(e).length` (any) and
  Hebrew's `this.minMaxMonthLength(e,"max")` (any) — mixed f64 / externref.
- L39 receiver not `ref`/`ref_null`; L216 `!recvIsClassStruct`.
- L18 first candidate has no param types; L82/L99 param-type gaps.
State the answer with the probe output in the PR.

**Step 2 — make the fallback SOUND.** Whatever the bail-out, a static bind to
`candidates[0]` is wrong for `candidates.length > 1`. Two acceptable shapes,
pick by what Step 1 says and measure both if cheap:
- (a) *Fix the bail-out* so the cascade emits — for L152, unify to `externref`
  (box numerics) when candidate result types disagree; the cascade's arms each
  box on their own path. This keeps the dispatch in-Wasm.
- (b) *Route the bail-out to the dynamic method path* — when
  `virtualCandidates.length > 1 && vresult === undefined`, do NOT keep
  `funcIdx = candidates[0]`; clear it so the call falls to the existing
  dynamic/host method-call path (`__extern_method_call` family), which resolves
  by runtime type. Verify that path actually handles a compiled-class receiver
  here (it does for #5243's `dateAdd` route) and does not just re-trap.
Either way: the `candidates.length === 1` collapse to a direct call stays ONLY
when the receiver's static class has no other descendants (a single declarer
with sibling subtrees is the same unsoundness); otherwise it needs a 1-arm
cascade with a sound terminal.

**Step 3 — terminal `else`.** The cascade's terminal is `unreachable`. With
#5249 every descendant has an arm, so it is reachable only for an instance of
the abstract base itself; leave it, but if (b) is chosen, the terminal for a
1-arm cascade must be the dynamic path, not `unreachable`.

**Step 4 — reduce + test.** `tests/issue-5352-*.test.ts`: a hierarchy whose
declarers return DIFFERENT types (numeric vs object) so the cascade bails
today; assert each subclass dispatches to its own body and a non-declaring
sibling does not reach a declarer's body. Base-failing on main.

**Step 5 — measure.** Re-run the #5249 `family-123.txt` list (worktree
`issue-5249-fix/.tmp/family-123.txt`, or regenerate from the census) with the
provider linked: report pass/fail and the new top reasons. Expect the 120
`HebrewHelper_minMaxMonthLength` rows to move; state how many turn green and
what the next layer is. Also re-run `tests/issue-5249-*`, the 8 dispatch
suites and the 9 provider suites (list in PR #5577), equivalence gate at
24/1718.

**Order-preservation constraint.** `candidates[0]` is the emitter's result
schema; changing candidate ORDER is out of scope — change what happens when
the emitter declines.

## Acceptance criteria

1. Step 1 answered with evidence (which bail-out, why).
2. Base-failing reduction; no static bind to `candidates[0]` for any open
   receiver with >1 candidate.
3. 123-row family re-measured; the 120-row Hebrew chain gone; new counts and
   next-layer reasons stated. Gates + suites green; equivalence at baseline.

## Notes

- Filed from PR #5577's "follow-up this exposes"; supersedes the Hebrew
  illegal-cast row of #5251.
- Id reserved via `claim-issue --allocate` with a degraded open-PR scan;
  open PRs checked by hand 2026-09-05.
