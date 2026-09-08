---
id: 5352
title: "Open-receiver `this.m()` statically binds to candidates[0] when the tag-cascade emitter bails — routes every non-Hebrew Temporal calendar into HebrewHelper (120 of 123 rows)"
status: done
completed: 2026-09-05
assignee: ttraenkler/dev-5352
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

## Implementation Notes (2026-09-05)

### Step 1 — which bail-out fires (measured, not inferred)

All nine `return undefined` sites in `emitVirtualMethodDispatchByTag` were
instrumented with a temporary `JS2WASM_DEBUG_VDISPATCH=1` log and the whole
`@js-temporal/polyfill@0.5.1` provider was built (cold, 39.4 s, 2,028,477 bytes).

**Exactly ONE site fires, nine times: `unified === undefined` — the
`unifyCascadeResultType` decline (the plan's L152 top suspect).** The other
eight sites fire zero times in the entire provider.

| method                          | candidates | arm result types                                       |
| ------------------------------- | ---------- | ------------------------------------------------------ |
| `maximumMonthLength` (×4)       | 25         | 23 × `f64`, 2 × `externref` (Hebrew, Indian)           |
| `minimumMonthLength` (×3)       | 25         | 23 × `f64`, 2 × `externref` (Hebrew, Indian)           |
| `monthDaySearchStartYear` (×1)  | 26         | 23 × `f64`, 3 × `externref` (the three Chinese helpers)|
| `maxLengthOfMonthCodeInAnyYear` | 25         | 24 × `f64`, 1 × `externref` (Indian)                   |

No arm is void. The divergence is purely numeric-vs-`any`: the polyfill's
bodies return `30` / `12===t?29:t<=6?31:30` (both `f64`) alongside
`this.minMaxMonthLength(e,"max")` and `this.getMonthInfo(e).length` (both typed
`any` by the checker, so `externref`). `armWideningKind` called `f64`
"unrepresentable", the emitter declined, and the caller static-bound all 25
receivers to `candidates[0]` — `HebrewHelper`.

### Step 2 — fix shape (a): fix the bail-out, keep dispatch in-Wasm

Shape (b) (route the decline to the dynamic host method path) was NOT chosen.
The measured decline is a pure result-type question with a known in-Wasm answer,
so (b) would have replaced a Wasm cascade with a host round trip for every one
of these calls, and it would have changed behaviour for the *other* eight
bail-out sites too — sites that never fire here and whose static fallback is
load-bearing elsewhere (e.g. the `externref`-receiver decline that `lit`'s
`class extends HTMLElement` relies on). (a) is strictly narrower.

Three changes, all in `src/codegen/expressions/virtual-dispatch.ts`:

1. `armIsBoxableNumber` — an `f64` arm reaches an `externref` cascade by
   BOXING. `armWideningKind` answers "is there a *free* representation
   change"; that is not the same question as "is there a representation at
   all", and conflating them is what turned a solvable type mismatch into an
   unsound static bind.
2. `ensureCascadeNumericBoxing` — registers `__box_number` **before the
   speculative snapshot and before any function index is captured**. This
   ordering is the load-bearing part: `ensureLateImport` can add an import,
   which shifts every defined-function index, and `candFinalIdx` is a plain
   `Map<number, number>` that no shift pass can reach. Registering after that
   capture would leave every arm calling one function too low. It registers
   only when the cascade actually mixes a boxable numeric with an `any`-side
   arm, so an all-numeric hierarchy neither widens nor gains an import.
3. `buildDispatchArmCall` — a numeric arm emits `call $__box_number` after its
   own call. Emitting a `call` inside an arm array is safe *here* precisely
   because the helper already exists; what #5178 ruled out was **minting** an
   import while building an arm array. The index is read from `ctx.funcMap` at
   build time, and `funcMap` is updated by every shift pass.

### Reported, not fixed (with bounds)

- **Void/value divergence still declines** (and still static-binds). Zero
  occurrences in the polyfill; would need a per-arm `drop` under an `empty`
  block type, or a pre-materialized default local for the void arms.
- **`i32` arms are not boxed.** `i32` is also this compiler's boolean
  representation and an arm's Wasm result type does not distinguish the two, so
  `__box_number` would be the wrong boxer for the boolean half. Zero
  occurrences in the polyfill.
- **The `candidates.length === 1` collapse to a direct call is unchanged.**
  It is the same unsoundness in principle when the receiver's static class has
  descendants that declare no implementation, but making it a 1-arm cascade
  turns today's wrong-body call into an `unreachable` trap for those receivers,
  which is a behaviour change with a much wider blast radius than the measured
  defect. Zero occurrences in the polyfill's four affected methods (all have
  25–26 candidates). Left for a separate, separately-measured change.

## Notes

- Filed from PR #5577's "follow-up this exposes"; supersedes the Hebrew
  illegal-cast row of #5251.
- Id reserved via `claim-issue --allocate` with a degraded open-PR scan;
  open PRs checked by hand 2026-09-05.
