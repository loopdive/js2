# opus-ir-2 — context summary (2026-08-16)

Developer teammate, IR-retirement lane (goal `ir-full-coverage`, epic #3518).
One task completed this window; stood down on the lead's budget directive
without claiming further work.

## Completed

**#4514 — R2 prepared-owner call closure, directional reverse-callers edge.**
PR [#4627](https://github.com/loopdive/js2wasm/pull/4627), branch
`issue-4514-r2-call-closure-directional` (pushed to `fork`), worktree
`/workspace/.claude/worktrees/agent-a0c3fa7d0629f96b2`. Issue file set to
`status: done` in the PR itself, per the self-merge path.

Result: standalone lane `legacyBodyEmittedCeiling` **26 → 18** (the issue asked
for ≤ 22), `emitted`/`irBodyEmitted` unchanged at 22, `unsupported` 15, 0
invariants, verdict READY. Single-host lane unchanged (37/37 IR, 0 legacy).
Runtime output for `algorithms.ts` byte-identical to base on both lanes.
Measured after merging current `main` (incl. #4615/#4616).

## The finding worth carrying forward

The issue predicted the naive fix would be unsound "because a direct reader
sits beside a still-prepared component". The symptom reproduced exactly —
`callable provider runtime|21:__extern_is_undefined was discovered after
prepared provider planning` — but **the mechanism is provider planning, not
call closure**, and that distinction is what unblocked the issue:

`ProgramAbiCallableProviderRegistry.planPrepared`
(`src/codegen/program-abi-provider-planning.ts`) seals the provider-key
denominator for the **whole compilation** on its first call, and provider
ordinals are positions in that sorted array. So preparing *any* subset of a
source file froze discovery before the units left on the late route had
lowered. That is why #4508's whole-file collapse "worked": with nothing
prepared, nothing sealed — the working state depended on preparing *zero* units
of the file, which is not a property anyone had written down.

Fix: a key first observed after sealing is **appended past the sealed prefix**
rather than refused. That preserves the only property the seal protects (no
already-minted ordinal can move, since every sealed position keeps its index)
while letting the prepared and late routes coexist in one compilation. A/B with
the throw disabled established the seal was the *sole* blocker before any
redesign — worth doing that A/B first, it turned a "step 3: component
splitting" redesign into a 20-line change.

**Generalisable:** any "partial preparation of X is fatal" symptom in this
subsystem should be checked against a compilation-wide seal before it is
attributed to the component-selection logic. Two of the four fixed-point
directions were suspected here; neither was involved.

## Open / follow-up

- **`check-ir-only --update` also wants single-host `legacyBodyEmittedCeiling`
  10 → 0** (that lane measures 0 legacy bodies before *and* after this change).
  Real, free ratchet value, but unearned by this PR, so I reverted it to 10.
  Someone should land it deliberately.
- **The new predicate's natural home is `src/codegen/ir-legacy-caller-abi.ts`**,
  which already owns the same proof shape for the select-stage closure. It
  cannot go there without exporting the selector's
  `r2SignatureMatchesAllocatedSlot`; that move does not belong inside a
  behavioural change, so the PR takes a `loc-budget-allow` for the +83 lines
  (~60 of them recorded rationale) instead.
- **`fibMemo`, `main` and `<module-init>` are still compile-twice** on
  standalone. `fibMemo` withdraws on the #4508 storage edge (the module-init is
  not a prepared storage terminal on this lane) and `main` follows on the callee
  edge. Making the standalone module-init preparable is the next lever there —
  it would take the remaining three, and it is adjacent to #4510.

## Not started (queue items left for the next window)

- #4510 (`ir-only` baseline pre/post-claim drift) — note that the
  `resolve/late-preparation-unsupported` residue is **already absent** from the
  current baseline's `unsupportedByCode`, which is the first thing that issue
  asks to re-measure.
- #3641 (dual-emit GC/standalone single compile) — untouched, L-sized.
- #4070 — was opus-ir-1's start point.

## Environment note

`npx tsc --noEmit` did not complete in three attempts (10, 25 and 40 minute
timeouts) at load average 22–27 on 8 cores. `biome`, `prettier`, LOC and
function budget gates all pass; CI's `quality` lane is the first full typecheck
this branch gets. Scoped compile probes (`npx tsx`) were the only affordable
validation loop under that load, and they were enough — `check:ir-only` itself
runs in a few minutes.
